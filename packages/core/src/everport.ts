// The public API of core: the one class that the CLI and VS Code call. It ties the configuration, Cloudflare
// (RelayDeployer) and the background agent (AgentControl) into the commands a person types.
import { CODE_VERSION } from '@everport/relay';
import { ConfigStore, findTunnel, type Config, type Tunnel } from './config-store.js';
import { EverportError, toEverportError } from './errors.js';
import { EventBus, type EverportEventListener } from './events.js';
import { FileLock } from './lock.js';
import type { Logger } from './logger.js';
import type { Layout } from './paths.js';
import type {
  AgentControl,
  AgentInfo,
  AgentTunnelInfo,
  FileSystem,
  LocalProbe,
  ProcessTable,
  WranglerRunner,
} from './ports.js';
import { defaultRandomHex } from './relay/names.js';
import { RelayDeployer, type TunnelHealth } from './relay/relay-deployer.js';
import { loadOrCreateRelaySecret } from './relay/secret.js';
import {
  MIN_NODE_LABEL,
  NODE_TOO_OLD_HINT,
  WRANGLER_VERSION,
  isSupportedNode,
  summarizeFailure,
  wranglerNeedsNewerNode,
} from './relay/wrangler.js';
import { InvalidTargetError, normalizeTarget, shortTarget } from './target.js';

/** Relay code from an older Everport. A newer one (another machine's Everport) is left alone. */
const isOlderRelay = (codeVersion: string | undefined): boolean =>
  codeVersion !== undefined && Number(codeVersion) < Number(CODE_VERSION);

export type TunnelState = 'active' | 'stopped' | 'down' | 'missing' | 'failed';
export type StopOutcome = 'stopped' | 'killed' | 'not-running';

export interface TunnelStatus {
  id: string;
  label: string;
  name: string;
  url: string;
  target: string;
  enabled: boolean;
  /** active: served and connected; stopped: switched off; down: the agent does not serve it; missing: the preview is gone; failed: see `error`. */
  state: TunnelState;
  /** Only with `status({ health: true })`: what answers at the public address. */
  health?: TunnelHealth;
  /** The relay on Cloudflare runs older code than this Everport (only with `health: true`). */
  outdated?: boolean;
  /** Only with `status({ health: true })`: the tunnel is online, but nothing accepts connections at its target. */
  localDown?: boolean;
  error?: { code: string; message: string; hint: string };
}

export interface DoctorCheck {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export interface AddInput {
  target: string;
  label?: string;
}

export interface EverportDeps {
  layout: Layout;
  fs: FileSystem;
  logger: Logger;
  events: EventBus;
  deployer: RelayDeployer;
  agent: AgentControl;
  /** Used by `doctor` to run the pinned wrangler. */
  wrangler: WranglerRunner;
  /** Used by the lock that keeps two Everport processes from changing tunnels at once. */
  processTable: ProcessTable;
  /** Checks that each online tunnel's local service accepts connections. Without it, nothing is checked. */
  local?: LocalProbe;
  pid: number;
  /** Name of the relay Worker created by the first `add`. Default `everport`. */
  workerName?: string;
  /** The version of the Node that runs wrangler and the agent, for `doctor`. Default: the Node running this code. */
  nodeVersion?: string;
  randomHex?: (bytes: number) => string;
  sleep?: (ms: number) => Promise<void>;
  /** How long `add` and `up` wait for a tunnel to connect. Default 10 s. */
  connectTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Said before the first tunnel is made. Measured (one run each, from Vietnam to Cloudflare, Windows): about 17 to 24 s
 * with wrangler already downloaded (about 10 s in a later manual try), about 70 s when it must be downloaded first; on GitHub Actions runners 5 to 6 s.
 */
const FIRST_TUNNEL_NOTE =
  'This is your first tunnel, so Everport also sets up the relay in your Cloudflare account. It can take 10 to 20 seconds (it varies), and a minute or more if wrangler has to be downloaded first.';

type TunnelError = NonNullable<TunnelStatus['error']>;

const toTunnelError = (e: unknown): TunnelError => {
  const error = toEverportError(e);
  return { code: error.code, message: error.message, hint: error.hint };
};

const DEFAULT_WORKER_NAME = 'everport';

export class Everport {
  private readonly store: ConfigStore;
  private readonly lock: FileLock;
  private readonly workerName: string;
  private readonly randomHex: (bytes: number) => string;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly d: EverportDeps) {
    this.store = new ConfigStore(d.fs, d.layout.configFile);
    this.lock = new FileLock(d.fs, d.processTable, d.layout.lockFile, d.pid);
    this.workerName = d.workerName ?? DEFAULT_WORKER_NAME;
    this.randomHex = d.randomHex ?? defaultRandomHex;
    this.sleep = d.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  on(_event: 'event', listener: EverportEventListener): () => void {
    return this.d.events.on(listener);
  }

  get dataDir(): string {
    return this.d.layout.dataDir;
  }

  get logFile(): string {
    return this.d.layout.logFile;
  }

  isLoggedIn(options: { fresh?: boolean } = {}): Promise<boolean> {
    return this.d.deployer.isLoggedIn(options);
  }

  /** `wrangler login`: opens the browser. Everport never sees the credentials. */
  login(options: { signal?: AbortSignal } = {}): Promise<void> {
    return this.d.deployer.login(options.signal);
  }

  /**
   * Makes a new tunnel: the relay on Cloudflare is created by the first one, then a preview, a check that it
   * answers, the configuration, and the agent starts serving it. The tunnel is saved even when only the last step
   * fails: the result then carries the error and `up` retries.
   */
  add(input: AddInput): Promise<TunnelStatus> {
    return this.locked(async () => {
      const target = this.parseTarget(input.target);
      const label = (input.label ?? target.replace(/^https?:\/\//, '')).trim();
      if (label === '') throw new EverportError('INVALID_NAME', 'The label is empty', 'Pass --label with a name.');
      const config = await this.store.load();
      if (config.tunnels.some((t) => t.label.toLowerCase() === label.toLowerCase())) {
        throw new EverportError(
          'TUNNEL_EXISTS',
          `A tunnel labelled "${label}" already exists`,
          'Pick another --label.',
        );
      }
      const first = config.relay === null;
      if (first) this.d.events.emit('relay:setup', FIRST_TUNNEL_NOTE);
      if (!(await this.d.deployer.isLoggedIn())) {
        throw new EverportError('NOT_LOGGED_IN', 'You are not logged in to Cloudflare', 'Run "everport login".');
      }

      const workerName = config.relay?.workerName ?? this.workerName;
      const secret = await loadOrCreateRelaySecret(this.d.fs, this.d.layout, this.randomHex);
      this.d.events.emit(
        'tunnel:creating',
        first
          ? `Creating ${label} and the relay on Cloudflare (10 to 20 seconds, it varies)`
          : `Creating ${label} on Cloudflare`,
      );
      const created = await this.d.deployer.createTunnel({
        workerName,
        secret,
        taken: config.tunnels.map((t) => t.name),
        label,
      });

      const tunnel: Tunnel = {
        id: this.newId(config),
        label,
        name: created.name,
        url: created.url,
        target,
        enabled: true,
      };
      try {
        await this.store.mutate((c) => {
          c.relay ??= {
            workerName,
            subdomain: created.subdomain,
            codeVersion: created.codeVersion,
            wranglerVersion: WRANGLER_VERSION,
          };
          c.tunnels.push(tunnel);
        });
      } catch (e) {
        await this.d.deployer.removeTunnel(workerName, created.name).catch(() => {}); // no preview left that nothing knows about
        throw e;
      }

      const error = await this.serve(tunnel);
      this.d.events.emit(
        error ? 'tunnel:failed' : 'tunnel:ready',
        error ? `${label}: ${error.message}` : `${label} is ready`,
        { id: tunnel.id },
      );
      return this.statusOf(tunnel, await this.d.agent.status(), error);
    });
  }

  /**
   * Starts everything the configuration asks for: checks each tunnel's preview, brings back one that is gone (same
   * address), starts the agent and gives it the tunnels. A tunnel that cannot be served comes back `failed` with the
   * reason; the others still run.
   */
  up(): Promise<TunnelStatus[]> {
    return this.locked(async () => {
      const config = await this.store.load();
      const enabled = config.tunnels.filter((t) => t.enabled);
      if (!config.relay || enabled.length === 0) return this.toStatuses(config, await this.d.agent.status());

      const secret = (await this.d.fs.readText(this.d.layout.relaySecretFile))?.trim();
      if (!secret) {
        throw new EverportError(
          'CONFIG_INVALID',
          `The relay secret is missing (${this.d.layout.relaySecretFile}), so the tunnels already on Cloudflare cannot be reached`,
          'Remove the tunnels and add them again: that creates a new secret.',
        );
      }

      const errors = new Map<string, TunnelError>();
      const { workerName } = config.relay;
      await this.settleAll(
        enabled.map((tunnel) => async () => {
          const error = await this.checkPreview(workerName, tunnel, secret);
          if (error) errors.set(tunnel.id, error);
        }),
      );

      this.d.events.emit('agent:starting', 'Starting the agent');
      await this.d.agent.ensureRunning();
      this.d.events.emit('agent:ready', 'The agent is running');

      const before = await this.d.agent.status();
      // A probe that timed out says nothing about a tunnel the agent is serving right now: keep it.
      for (const tunnel of enabled) {
        const served = before?.tunnels.find((t) => t.name === tunnel.name);
        if (errors.get(tunnel.id)?.code === 'RELAY_UNREACHABLE' && served?.state === 'connected')
          errors.delete(tunnel.id);
      }
      const wanted = enabled.filter((t) => !errors.has(t.id));
      for (const stale of before?.tunnels ?? []) {
        if (!wanted.some((t) => t.name === stale.name)) await this.d.agent.removeTunnel(stale.name);
      }
      for (const tunnel of wanted) {
        try {
          await this.d.agent.addTunnel({ name: tunnel.name, url: tunnel.url, target: tunnel.target });
        } catch (e) {
          errors.set(tunnel.id, toTunnelError(e));
        }
      }
      const info = await this.waitConnected(wanted.filter((t) => !errors.has(t.id)).map((t) => t.name));
      return this.toStatuses(await this.store.load(), info, errors);
    });
  }

  /** Stops the agent. The previews stay on Cloudflare, so the addresses stay. */
  down(): Promise<StopOutcome> {
    return this.locked(() => this.d.agent.stop());
  }

  /**
   * Removes the preview from Cloudflare first (the step that can fail), then from the agent and the configuration.
   * `localOnly` skips Cloudflare, for when it cannot be reached or the Worker is gone; the preview may then remain.
   */
  remove(idOrLabel: string, options: { localOnly?: boolean } = {}): Promise<void> {
    return this.locked(async () => {
      const config = await this.store.load();
      const tunnel = findTunnel(config, idOrLabel);
      if (!options.localOnly) {
        await this.d.deployer.removeTunnel(config.relay?.workerName ?? this.workerName, tunnel.name);
      }
      await this.d.agent.removeTunnel(tunnel.name).catch(() => false); // an agent that is not there is fine
      await this.store.mutate((c) => {
        c.tunnels = c.tunnels.filter((t) => t.id !== tunnel.id);
      });
      this.d.events.emit('tunnel:released', `Removed ${tunnel.label}`, { id: tunnel.id });
    });
  }

  start(idOrLabel: string): Promise<TunnelStatus> {
    return this.setEnabled(idOrLabel, true);
  }

  stop(idOrLabel: string): Promise<TunnelStatus> {
    return this.setEnabled(idOrLabel, false);
  }

  /** A read-only snapshot. `health: true` also asks every enabled tunnel's public address who answers. */
  async status(options: { health?: boolean } = {}): Promise<TunnelStatus[]> {
    const config = await this.store.load();
    const health = new Map<string, { health: TunnelHealth; codeVersion?: string }>();
    if (options.health) {
      await this.settleAll(
        config.tunnels
          .filter((t) => t.enabled)
          .map((t) => async () => {
            health.set(t.id, await this.d.deployer.checkTunnel(t.url, t.name));
          }),
      );
    }
    const statuses = this.toStatuses(config, await this.d.agent.status(), undefined, health);
    return options.health ? this.withLocal(statuses) : statuses;
  }

  /** Marks online tunnels whose local service does not accept connections. Only done when asked (`health`). */
  private async withLocal(statuses: TunnelStatus[]): Promise<TunnelStatus[]> {
    const probe = this.d.local;
    if (!probe) return statuses;
    return Promise.all(
      statuses.map(async (s) => {
        if (s.state !== 'active') return s;
        const listening = await probe.listening(s.target).catch(() => true);
        return listening ? s : { ...s, localDown: true };
      }),
    );
  }

  /** Every check runs, whatever the others say. */
  async doctor(): Promise<DoctorCheck[]> {
    const checks: DoctorCheck[] = [];
    const check = async (name: string, fn: () => Promise<Omit<DoctorCheck, 'name'>>) => {
      try {
        checks.push({ name, ...(await fn()) });
      } catch (e) {
        const error = toEverportError(e);
        checks.push({ name, ok: false, detail: error.message, ...(error.hint ? { hint: error.hint } : {}) });
      }
    };

    await check('node', async () => {
      // The Node that will run wrangler and the agent. Inside an editor that is not the editor's own Node.
      const version = this.d.nodeVersion ?? process.version;
      const ok = isSupportedNode(version);
      return { ok, detail: version, ...(ok ? {} : { hint: `Everport needs Node.js ${MIN_NODE_LABEL} or newer.` }) };
    });

    await check('wrangler', async () => {
      const result = await this.d.wrangler.run(['--version'], { timeoutMs: 120_000 });
      const version = /\d+\.\d+\.\d+/.exec(result.stdout)?.[0];
      if (result.code !== 0 || !version) {
        return {
          ok: false,
          detail: summarizeFailure(result),
          hint: wranglerNeedsNewerNode(result)
            ? NODE_TOO_OLD_HINT
            : 'Check that "npx" works (it comes with Node) and that the network is up.',
        };
      }
      return version === WRANGLER_VERSION
        ? { ok: true, detail: `wrangler ${version}` }
        : {
            ok: false,
            detail: `wrangler ${version}, expected ${WRANGLER_VERSION}`,
            hint: 'Everport pins the wrangler it was tested with.',
          };
    });

    await check('cloudflare login', async () =>
      (await this.d.deployer.isLoggedIn({ fresh: true }))
        ? { ok: true, detail: 'logged in' }
        : { ok: false, detail: 'not logged in', hint: 'Run "everport login".' },
    );

    await check('data folder', async () => {
      const probe = `${this.d.layout.dataDir}${this.d.layout.platform === 'win32' ? '\\' : '/'}.write-check`;
      await this.d.fs.writeText(probe, 'ok');
      await this.d.fs.remove(probe);
      return { ok: true, detail: this.d.layout.dataDir };
    });

    let config: Config | undefined;
    await check('configuration', async () => {
      config = await this.store.load();
      return { ok: true, detail: `${config.tunnels.length} tunnel(s)` };
    });

    const relay = config?.relay;
    if (relay) {
      await check('relay', async () => {
        const state = await this.d.deployer.probeWorker(relay.workerName);
        if (state === 'previews-only')
          return { ok: true, detail: `Worker "${relay.workerName}" on ${relay.subdomain}.workers.dev` };
        return state === 'none'
          ? {
              ok: false,
              detail: `Worker "${relay.workerName}" is gone from your account`,
              hint: 'Run "everport up": it brings the previews back.',
            }
          : {
              ok: false,
              detail: `"${relay.workerName}" now has deployed versions: it is not an Everport relay`,
              hint: 'Everport never touches a Worker it did not create.',
            };
      });
      await check('relay secret', async () =>
        (await this.d.fs.readText(this.d.layout.relaySecretFile))?.trim()
          ? { ok: true, detail: 'present' }
          : { ok: false, detail: 'missing', hint: 'Remove the tunnels and add them again.' },
      );
    } else if (config) {
      checks.push({ name: 'relay', ok: true, detail: 'none yet: the first "everport add" creates it' });
    }

    for (const tunnel of config?.tunnels.filter((t) => t.enabled) ?? []) {
      await check(`tunnel ${tunnel.label}`, async () => {
        const { health, codeVersion } = await this.d.deployer.checkTunnel(tunnel.url, tunnel.name);
        if (health === 'ok') {
          if (this.d.local && !(await this.d.local.listening(tunnel.target).catch(() => true))) {
            // The tunnel is fine; the app behind it is not started. A note, not a failure.
            return { ok: true, detail: `${tunnel.url} works; waiting for your app on ${shortTarget(tunnel.target)}` };
          }
          return codeVersion === CODE_VERSION
            ? { ok: true, detail: tunnel.url }
            : { ok: true, detail: `${tunnel.url} (relay code ${codeVersion}, this Everport ships ${CODE_VERSION})` };
        }
        const problems: Record<Exclude<TunnelHealth, 'ok'>, { detail: string; hint: string }> = {
          'not-found': {
            detail: `nothing at ${tunnel.url}: the preview is gone`,
            hint: 'Run "everport up": it brings it back at the same address.',
          },
          mismatch: {
            detail: `${tunnel.url} is not answered by your relay for this tunnel`,
            hint: 'Another Worker may use the address. Remove the tunnel and add it with another label.',
          },
          unreachable: { detail: `cannot reach ${tunnel.url}`, hint: 'Check the network.' },
        };
        return { ok: false, ...problems[health] };
      });
    }

    await check('agent', async () => {
      const info = await this.d.agent.status();
      return info
        ? { ok: true, detail: `running (pid ${info.pid}), serving ${info.tunnels.length} tunnel(s)` }
        : { ok: true, detail: 'not running ("everport up" starts it)' };
    });

    return checks;
  }

  private async setEnabled(idOrLabel: string, enabled: boolean): Promise<TunnelStatus> {
    return this.locked(async () => {
      const found = findTunnel(await this.store.load(), idOrLabel);
      await this.store.mutate((c) => {
        const tunnel = c.tunnels.find((t) => t.id === found.id);
        if (tunnel) tunnel.enabled = enabled;
      });
      const tunnel = { ...found, enabled };
      let error: TunnelError | undefined;
      if ((await this.d.agent.status()) !== null) {
        try {
          if (enabled) {
            await this.d.agent.addTunnel({ name: tunnel.name, url: tunnel.url, target: tunnel.target });
            await this.waitConnected([tunnel.name]);
          } else {
            await this.d.agent.removeTunnel(tunnel.name);
          }
        } catch (e) {
          error = toTunnelError(e);
        }
      }
      return this.statusOf(tunnel, await this.d.agent.status(), error);
    });
  }

  /**
   * Looks at one tunnel's preview before the agent is started. Returns the problem, or undefined when the tunnel can
   * be served (after it was brought back, if it was gone). Asks /__ep/version only; a handshake would push a running
   * agent out, so a tunnel is taken off the agent before it is redeployed.
   */
  private async checkPreview(workerName: string, tunnel: Tunnel, secret: string): Promise<TunnelError | undefined> {
    const { health, codeVersion } = await this.d.deployer.checkTunnel(tunnel.url, tunnel.name);
    if (health === 'ok') {
      // Relay code 1 lets any WebSocket (a page's live reload, say) become the agent: it must not stay.
      if (!isOlderRelay(codeVersion)) return undefined;
      return this.redeploy(workerName, tunnel, secret, {
        loginReason: `The relay of "${tunnel.label}" is outdated and Cloudflare needs a login to update it`,
        done: () => `Updated the relay of ${tunnel.label}`,
      });
    }
    if (health === 'unreachable') {
      return toTunnelError(
        new EverportError(
          'RELAY_UNREACHABLE',
          `Cannot reach ${tunnel.url}`,
          'Check the network, then run "everport up" again.',
        ),
      );
    }
    if (health === 'mismatch') {
      return toTunnelError(
        new EverportError(
          'RELAY_MISMATCH',
          `${tunnel.url} is not answered by your relay for "${tunnel.name}"`,
          'Another Worker may use the address. Remove the tunnel and add it with another label.',
        ),
      );
    }
    return this.redeploy(workerName, tunnel, secret, {
      loginReason: `The preview of "${tunnel.label}" is gone and Cloudflare needs a login to bring it back`,
      done: (url) => `Brought ${tunnel.label} back at ${url}`,
      mustBeGone: true,
    });
  }

  /**
   * Deploys the tunnel's preview again under its name, with this Everport's relay code. The agent lets go of the
   * tunnel first, since the check after the deploy connects as the agent.
   */
  private async redeploy(
    workerName: string,
    tunnel: Tunnel,
    secret: string,
    how: { loginReason: string; done: (url: string) => string; mustBeGone?: boolean },
  ): Promise<TunnelError | undefined> {
    try {
      if (!(await this.d.deployer.isLoggedIn())) {
        throw new EverportError('NOT_LOGGED_IN', how.loginReason, 'Run "everport login", then "everport up".');
      }
      if (how.mustBeGone && (await this.d.deployer.previewExists(workerName, tunnel.name))) {
        throw new EverportError(
          'RELAY_MISMATCH',
          `${tunnel.url} does not answer, but the preview exists on Cloudflare`,
          'Another Worker may use the address. Remove the tunnel and add it with another label.',
        );
      }
      await this.d.agent.removeTunnel(tunnel.name).catch(() => false);
      const back = await this.d.deployer.recreateTunnel({ workerName, name: tunnel.name, label: tunnel.label, secret });
      if (back.url !== tunnel.url) {
        await this.store.mutate((c) => {
          const stored = c.tunnels.find((t) => t.id === tunnel.id);
          if (stored) stored.url = back.url;
        });
        tunnel.url = back.url;
      }
      this.d.events.emit('tunnel:ready', how.done(back.url), { id: tunnel.id });
      return undefined;
    } catch (e) {
      return toTunnelError(e);
    }
  }

  /** Hands one tunnel to the agent, starting it if needed. Returns the error instead of throwing. */
  private async serve(tunnel: Tunnel): Promise<TunnelError | undefined> {
    try {
      await this.d.agent.ensureRunning();
      await this.d.agent.addTunnel({ name: tunnel.name, url: tunnel.url, target: tunnel.target });
      await this.waitConnected([tunnel.name]);
      return undefined;
    } catch (e) {
      return toTunnelError(e);
    }
  }

  /** Waits until the named tunnels have connected, or say why they cannot, or the time is up. */
  private async waitConnected(names: string[]): Promise<AgentInfo | null> {
    if (names.length === 0) return this.d.agent.status();
    const timeout = this.d.connectTimeoutMs ?? 10_000;
    const poll = this.d.pollMs ?? 200;
    const waited = { ms: 0 };
    for (;;) {
      const info = await this.d.agent.status();
      if (!info) return null;
      const pending = names.filter((name) => {
        const t = info.tunnels.find((x) => x.name === name);
        return !t || (t.state === 'connecting' && !t.lastError);
      });
      if (pending.length === 0 || waited.ms >= timeout) return info;
      await this.sleep(poll);
      waited.ms += poll;
    }
  }

  private toStatuses(
    config: Config,
    info: AgentInfo | null,
    errors: Map<string, TunnelError> = new Map(),
    health: Map<string, { health: TunnelHealth; codeVersion?: string }> = new Map(),
  ): TunnelStatus[] {
    return config.tunnels.map((t) => this.statusOf(t, info, errors.get(t.id), health.get(t.id)));
  }

  private statusOf(
    tunnel: Tunnel,
    info: AgentInfo | null,
    error?: TunnelError,
    health?: { health: TunnelHealth; codeVersion?: string },
  ): TunnelStatus {
    const base = { ...tunnel };
    const withHealth = (status: TunnelStatus): TunnelStatus =>
      health
        ? {
            ...status,
            health: health.health,
            ...(health.codeVersion !== undefined && { outdated: isOlderRelay(health.codeVersion) }),
          }
        : status;

    if (!tunnel.enabled) return withHealth({ ...base, state: 'stopped' });
    if (error) return withHealth({ ...base, state: 'failed', error });
    // A preview that is gone is the thing to fix, whatever the agent is doing: `up` brings it back.
    if (health?.health === 'not-found') return withHealth({ ...base, state: 'missing' });

    const served = info?.tunnels.find((t) => t.name === tunnel.name);
    if (!info || !served) return withHealth({ ...base, state: 'down' });
    const agentError = this.agentError(served);
    if (agentError) return withHealth({ ...base, state: 'failed', error: agentError });
    if (served.state === 'connected') {
      if (health?.health === 'mismatch') {
        return withHealth({
          ...base,
          state: 'failed',
          error: toTunnelError(
            new EverportError(
              'RELAY_MISMATCH',
              `${tunnel.url} is not answered by your relay for "${tunnel.name}"`,
              'Run "everport doctor".',
            ),
          ),
        });
      }
      return withHealth({ ...base, state: 'active' });
    }
    return withHealth({ ...base, state: 'down' });
  }

  private agentError(served: AgentTunnelInfo): TunnelError | undefined {
    if (served.state === 'replaced') {
      return toTunnelError(
        new EverportError(
          'AGENT_REPLACED',
          'Another agent took this tunnel',
          'Another Everport (for example another VS Code window) serves it. Close it, or run "everport up" here.',
        ),
      );
    }
    if (served.state === 'connecting' && served.lastError) {
      return toTunnelError(
        new EverportError(
          'RELAY_UNREACHABLE',
          served.lastError,
          'The agent keeps trying. Run "everport doctor" if it does not recover.',
        ),
      );
    }
    return undefined;
  }

  private parseTarget(input: string): string {
    try {
      return normalizeTarget(input);
    } catch (e) {
      if (e instanceof InvalidTargetError) {
        throw new EverportError('INVALID_TARGET', e.message, 'Use a port (3000) or a URL (http://localhost:3000).');
      }
      throw e;
    }
  }

  private newId(config: Config): string {
    for (;;) {
      const id = this.randomHex(3);
      if (!config.tunnels.some((t) => t.id === id)) return id;
    }
  }

  /** Runs the tasks together and waits for all of them; each task handles its own errors. */
  private async settleAll(tasks: (() => Promise<void>)[]): Promise<void> {
    await Promise.all(tasks.map((task) => task()));
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    return this.lock.withLock(fn);
  }
}
