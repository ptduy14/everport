// Puts tunnels on Cloudflare: one Worker (the relay) in the user's account and one preview of it per tunnel.
// Everything goes through the WranglerRunner and RelayProbe ports, so it is tested without Cloudflare.
import { CODE_VERSION, connectToken, renderWranglerConfig } from '@everport/relay';
import { EverportError } from '../errors.js';
import type { Logger } from '../logger.js';
import { joinPath, type Layout } from '../paths.js';
import type { FileSystem, RelayProbe, RelayVersionProbe, WranglerRunner } from '../ports.js';
import { defaultRandomHex, normalizeTunnelName } from './names.js';
import {
  parseLoggedIn,
  parsePreviewJson,
  parseWorkerState,
  previewMissing,
  wranglerError,
  type PreviewInfo,
  type WorkerState,
} from './wrangler.js';

export interface RelayDeployerDeps {
  wrangler: WranglerRunner;
  probe: RelayProbe;
  fs: FileSystem;
  layout: Layout;
  logger: Logger;
  /** The bundled relay Worker (packages/relay/dist/worker.js). */
  workerFile: string;
  randomHex?: (bytes: number) => string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** How long a "logged in" answer is trusted. Default 10 minutes. */
  loginCacheMs?: number;
  /** Tries to see a new preview answer: Cloudflare takes up to about a second to spread it. */
  verifyAttempts?: number;
  verifyDelayMs?: number;
}

export interface CreatedTunnel {
  id: string;
  /** What the person typed. */
  label: string;
  /** The slug Cloudflare returned: the tunnel's name inside the relay and in its token. */
  name: string;
  url: string;
  subdomain: string;
  codeVersion: string;
}

export interface NewTunnels {
  workerName: string;
  secret: string;
  /** Names already used by other tunnels in the configuration. */
  taken: string[];
  labels: string[];
}

export type TunnelHealth = 'ok' | 'not-found' | 'mismatch' | 'unreachable';

const sleepDefault = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class RelayDeployer {
  private loginCache: { value: boolean; at: number } | undefined;
  private readonly randomHex: (bytes: number) => string;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly deps: RelayDeployerDeps) {
    this.randomHex = deps.randomHex ?? defaultRandomHex;
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? sleepDefault;
  }

  /** Whether wrangler is logged in. The answer is kept for a while: asking wrangler takes 4 to 6 seconds. */
  async isLoggedIn(options: { fresh?: boolean } = {}): Promise<boolean> {
    const ttl = this.deps.loginCacheMs ?? 10 * 60_000;
    if (!options.fresh && this.loginCache && this.now() - this.loginCache.at < ttl) return this.loginCache.value;
    const result = await this.deps.wrangler.run(['whoami', '--json'], { timeoutMs: 60_000 });
    const value = parseLoggedIn(result);
    this.loginCache = { value, at: this.now() };
    return value;
  }

  /** `wrangler login`: opens the browser and waits for the person. Everport never sees the credentials. */
  async login(signal?: AbortSignal): Promise<void> {
    const result = await this.deps.wrangler.run(['login'], {
      interactive: true,
      timeoutMs: 5 * 60_000,
      ...(signal && { signal }),
    });
    this.loginCache = undefined;
    if (signal?.aborted) throw new EverportError('CANCELLED', 'The Cloudflare login was cancelled');
    if (result.code !== 0 || !(await this.isLoggedIn({ fresh: true }))) {
      throw new EverportError('NOT_LOGGED_IN', 'The Cloudflare login did not finish', 'Run "everport login" again.');
    }
  }

  /** does a Worker of this name exist, and is it only previews. */
  async probeWorker(workerName: string): Promise<WorkerState> {
    const result = await this.deps.wrangler.run(['versions', 'list', '--name', workerName, '--json'], {
      timeoutMs: 60_000,
    });
    return parseWorkerState(result);
  }

  async createTunnel(args: Omit<NewTunnels, 'labels'> & { label: string }): Promise<CreatedTunnel> {
    const [created] = await this.createTunnels({ ...args, labels: [args.label] });
    return created!;
  }

  /**
   * Creates one preview per label. The first one on a Worker that does not exist yet goes alone (it creates the
   * Worker; three at once fail with error 10040), the rest in parallel. All or nothing: if one fails, the ones
   * that were made are removed again.
   */
  async createTunnels({ workerName, secret, taken, labels }: NewTunnels): Promise<CreatedTunnel[]> {
    const planned = labels.map((label) => ({ label, name: normalizeTunnelName(label, workerName, this.randomHex) }));
    const seen = new Set(taken);
    for (const { label, name } of planned) {
      if (seen.has(name)) {
        throw new EverportError(
          'TUNNEL_EXISTS',
          `A tunnel named "${name}" already exists (from "${label}")`,
          'Pick another label.',
        );
      }
      seen.add(name);
    }

    const state = await this.probeWorker(workerName);
    if (state === 'regular') {
      throw new EverportError(
        'WORKER_NAME_TAKEN',
        `A Worker named "${workerName}" already exists in your account and is not an Everport relay`,
        'Choose another relay name; Everport never touches a Worker it did not create.',
      );
    }

    const dir = await this.prepareRelayDir(workerName);
    const created: CreatedTunnel[] = [];
    const deploy = async (item: { label: string; name: string }) => {
      const tunnel = await this.deployPreview(dir, workerName, item.name, item.label, secret);
      created.push(tunnel);
      return tunnel;
    };

    const results: PromiseSettledResult<CreatedTunnel>[] = [];
    let rest = planned;
    if (state === 'none') {
      const [first, ...others] = planned;
      const firstResult = await deploy(first!).then(
        (value) => ({ status: 'fulfilled', value }) as const,
        (reason: unknown) => ({ status: 'rejected', reason }) as const,
      );
      results.push(firstResult);
      rest = firstResult.status === 'fulfilled' ? others : [];
    }
    results.push(...(await Promise.allSettled(rest.map(deploy))));

    const failure = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failure) {
      for (const tunnel of created) await this.removeTunnel(workerName, tunnel.name).catch(() => {});
      throw failure.reason;
    }
    return planned.map((p) => created.find((c) => c.label === p.label)!);
  }

  /**
   * Deploys a preview under a name that is already known: brings back one that went missing (same name, so the
   * same URL), and is also how a preview gets new relay code or a new secret.
   */
  async recreateTunnel(args: {
    workerName: string;
    name: string;
    label?: string;
    secret: string;
  }): Promise<CreatedTunnel> {
    const dir = await this.prepareRelayDir(args.workerName);
    return this.deployPreview(dir, args.workerName, args.name, args.label ?? args.name, args.secret);
  }

  /** Removes a preview. One that is already gone counts as removed. */
  async removeTunnel(workerName: string, name: string): Promise<void> {
    const result = await this.deps.wrangler.run(
      ['preview', 'delete', '--name', name, '--worker-name', workerName, '--skip-confirmation'],
      { timeoutMs: 120_000 },
    );
    if (result.code !== 0 && !previewMissing(result)) throw wranglerError(result, 'removing the preview');
  }

  /** Removes the whole Worker. Only for cleaning up; removing one tunnel never calls this. */
  async deleteRelay(workerName: string): Promise<void> {
    const result = await this.deps.wrangler.run(['delete', '--name', workerName, '--force'], { timeoutMs: 120_000 });
    if (result.code !== 0 && !/\[code: 10007\]|does not exist/i.test(result.stderr)) {
      throw wranglerError(result, 'removing the relay');
    }
  }

  /** Whether the preview exists, by asking Cloudflare (not by calling its URL). */
  async previewExists(workerName: string, name: string): Promise<boolean> {
    const result = await this.deps.wrangler.run(
      ['preview', 'secret', 'list', '--name', name, '--worker-name', workerName],
      {
        timeoutMs: 60_000,
      },
    );
    if (result.code === 0) return true;
    if (previewMissing(result)) return false;
    throw wranglerError(result, 'looking for the preview');
  }

  /**
   * Who answers at a tunnel's address. Asks /__ep/version only: it is safe while the agent runs, whereas a
   * handshake would connect as the agent and push the real one out.
   */
  async checkTunnel(url: string, name: string): Promise<{ health: TunnelHealth; codeVersion?: string }> {
    const version = await this.deps.probe.version(url);
    if (version.kind === 'unreachable') return { health: 'unreachable' };
    if (version.kind === 'other') return { health: version.status === 404 ? 'not-found' : 'mismatch' };
    return { health: version.tunnel === name ? 'ok' : 'mismatch', codeVersion: version.codeVersion };
  }

  /** Writes wrangler.toml and the Worker next to each other, where `wrangler preview` runs. */
  private async prepareRelayDir(workerName: string): Promise<string> {
    const { fs, layout } = this.deps;
    const dir = joinPath(layout.platform, layout.dataDir, 'relay');
    await fs.writeText(joinPath(layout.platform, dir, 'wrangler.toml'), renderWranglerConfig({ workerName }));
    await fs.copyFile(this.deps.workerFile, joinPath(layout.platform, dir, 'worker.js'));
    return dir;
  }

  private async deployPreview(
    dir: string,
    workerName: string,
    name: string,
    label: string,
    secret: string,
  ): Promise<CreatedTunnel> {
    let preview = await this.runPreview(dir, workerName, name, name, secret);
    if (preview.slug !== name) {
      // The tunnel name inside the relay must equal the slug, since the agent signs its token with the slug.
      this.deps.logger.warn(`preview "${name}" got the slug "${preview.slug}": redeploying it with that name`);
      preview = await this.runPreview(dir, workerName, name, preview.slug, secret);
    }
    try {
      await this.verifyTunnel(preview.url, preview.slug, secret);
    } catch (e) {
      await this.removeTunnel(workerName, name).catch(() => {}); // a tunnel that cannot be used is not left behind
      throw e;
    }
    return {
      id: preview.id,
      label,
      name: preview.slug,
      url: preview.url,
      subdomain: preview.subdomain,
      codeVersion: CODE_VERSION,
    };
  }

  private async runPreview(
    dir: string,
    workerName: string,
    previewName: string,
    tunnel: string,
    secret: string,
  ): Promise<PreviewInfo> {
    const { fs, layout, wrangler } = this.deps;
    // The secret goes to wrangler in a private file, never through a shell pipe (which stored a wrong value).
    const secretsFile = joinPath(layout.platform, dir, `secrets-${this.randomHex(6)}.json`);
    await fs.writeTextPrivate(secretsFile, JSON.stringify({ SECRET: secret }));
    try {
      const result = await wrangler.run(
        [
          'preview',
          '--name',
          previewName,
          '--worker-name',
          workerName,
          '--var',
          `TUNNEL:${tunnel}`,
          '--secrets-file',
          secretsFile,
          '--json',
        ],
        { cwd: dir, timeoutMs: 180_000 },
      );
      if (result.code !== 0) throw wranglerError(result, 'creating the preview');
      return parsePreviewJson(result.stdout);
    } finally {
      await fs.remove(secretsFile).catch(() => {});
    }
  }

  /**
   * After a preview was created or its secret changed: is it our relay, for this tunnel, and does it take our token?
   * The first question is asked before the second, so a stranger's Worker that shadows the address never
   * receives a valid token. The handshake connects as the agent: only use it while no agent serves this tunnel.
   */
  private async verifyTunnel(url: string, tunnel: string, secret: string): Promise<void> {
    const attempts = this.deps.verifyAttempts ?? 5;
    const delay = this.deps.verifyDelayMs ?? 700;

    let version: RelayVersionProbe = { kind: 'unreachable', error: 'not asked' };
    for (let i = 0; i < attempts; i++) {
      version = await this.deps.probe.version(url);
      if (version.kind === 'relay') break;
      if (i < attempts - 1) await this.sleep(delay);
    }
    if (version.kind === 'unreachable') {
      throw new EverportError(
        'WRANGLER_FAILED',
        `The new tunnel does not answer at ${url}: ${version.error}`,
        'Run "everport doctor".',
      );
    }
    if (version.kind === 'other' || version.tunnel !== tunnel) {
      throw new EverportError(
        'RELAY_MISMATCH',
        `${url} is not answered by your relay for "${tunnel}"`,
        'Another Worker may use the same address. Pick another label.',
      );
    }

    const token = await connectToken(secret, tunnel);
    let status = 0;
    for (let i = 0; i < attempts; i++) {
      status = await this.deps.probe.handshake(url, token);
      if (status === 101) return;
      if (status === 403) {
        throw new EverportError(
          'WRANGLER_FAILED',
          'The relay rejected the secret that was just stored',
          'Run "everport doctor".',
        );
      }
      if (i < attempts - 1) await this.sleep(delay);
    }
    throw new EverportError(
      'WRANGLER_FAILED',
      `The relay did not accept the agent entrance (status ${status})`,
      'Run "everport doctor".',
    );
  }
}
