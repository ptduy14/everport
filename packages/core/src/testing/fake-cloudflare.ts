// A pretend Cloudflare account for testing the deployer: the wrangler commands Everport uses and the relay's public
// addresses, in one state. Output formats are the real ones, kept as fixtures from wrangler 4.166.0.
import { readFileSync } from 'node:fs';
import { connectToken } from '@everport/relay';
import { joinPath } from '../paths.js';
import type {
  CliResult,
  FileSystem,
  RelayProbe,
  RelayVersionProbe,
  WranglerRunOptions,
  WranglerRunner,
} from '../ports.js';

const fixture = (name: string): string => readFileSync(new URL(`./fixtures/wrangler/${name}`, import.meta.url), 'utf8');

interface FakePreview {
  id: string;
  slug: string;
  name: string;
  vars: Record<string, string>;
  secret: string;
  codeVersion: string;
}

export interface FakeWorker {
  /** A Worker that has deployed versions of its own, not just previews. */
  regular: boolean;
  previews: Map<string, FakePreview>;
}

export interface WranglerCall {
  args: string[];
  cwd?: string;
  interactive?: boolean;
  env?: Record<string, string>;
  startedAt: number;
  finishedAt?: number;
}

const ok = (stdout = ''): CliResult => ({ code: 0, stdout, stderr: '' });
const fail = (stderr: string, stdout = ''): CliResult => ({ code: 1, stdout, stderr });

const flag = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const defaultSlug = (name: string, workerName: string): string =>
  name
    .toLowerCase()
    .replace(/[_.]/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 63 - 1 - workerName.length);

export class FakeCloudflare {
  workers = new Map<string, FakeWorker>();
  subdomain = 'example';
  wranglerVersion = '4.166.0';
  loggedIn = true;
  loginSucceeds = true;
  /** How long creating a preview takes: long enough for two creations of a new Worker to overlap. */
  createDelayMs = 25;
  /** The first N version probes (or handshakes) answer 404, as before a new preview has spread. */
  notReadyVersionProbes = 0;
  notReadyHandshakes = 0;
  /** Store a wrong secret, the way a secret piped through a shell once was. */
  corruptStoredSecret = false;
  slugFor: (name: string, workerName: string) => string = defaultSlug;
  /** Hostnames that a stranger's Worker answers. */
  shadowed = new Set<string>();
  unreachable = false;
  /**
   * Makes wrangler calls that start with `prefix` fail with `text`. `skip` lets that many matching calls through first.
   * It stays in force until the test clears it.
   */
  failCommand: { prefix: string[]; text: string; skip?: number } | undefined;
  calls: WranglerCall[] = [];
  handshakes: string[] = [];

  private creating = new Set<string>();
  private idCounter = 0;
  readonly wrangler: WranglerRunner = { run: (args, options) => this.run(args, options) };
  readonly probe: RelayProbe = {
    handshake: (url, token) => this.handshake(url, token),
    version: (url) => this.version(url),
  };

  constructor(
    private readonly fs: FileSystem,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  worker(name: string): FakeWorker | undefined {
    return this.workers.get(name);
  }

  preview(workerName: string, name: string): FakePreview | undefined {
    return this.workers.get(workerName)?.previews.get(name);
  }

  urlOf(workerName: string, slug: string): string {
    return `https://${slug}-${workerName}.${this.subdomain}.workers.dev`;
  }

  private async run(args: string[], options: WranglerRunOptions = {}): Promise<CliResult> {
    const call: WranglerCall = {
      args,
      cwd: options.cwd,
      interactive: options.interactive,
      env: options.env,
      startedAt: Date.now(),
    };
    this.calls.push(call);
    try {
      const rule = this.failCommand;
      if (rule && rule.prefix.every((word, i) => args[i] === word)) {
        if (rule.skip && rule.skip > 0) rule.skip--;
        else return fail(`X [ERROR] ${rule.text}\n`);
      }
      return await this.dispatch(args, options);
    } finally {
      call.finishedAt = Date.now();
    }
  }

  private async dispatch(args: string[], options: WranglerRunOptions): Promise<CliResult> {
    const [command, sub] = args;
    if (command === 'login') {
      if (options.signal?.aborted) return { code: 130, stdout: '', stderr: 'cancelled' };
      if (this.loginSucceeds) this.loggedIn = true;
      return this.loginSucceeds ? ok() : { code: 1, stdout: '', stderr: '' };
    }
    if (command === '--version') return ok(`${this.wranglerVersion}\n`);
    if (command === 'whoami') {
      return this.loggedIn
        ? ok(
            JSON.stringify({
              loggedIn: true,
              authType: 'OAuth Token',
              email: 'user@example.com',
              accounts: [],
              tokenPermissions: [],
            }),
          )
        : { code: 1, stdout: '{"loggedIn":false}\n', stderr: '' };
    }
    if (!this.loggedIn) {
      return fail(
        "X [ERROR] In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable\n",
      );
    }

    if (command === 'versions' && sub === 'list') {
      const name = flag(args, '--name') ?? '';
      const worker = this.workers.get(name);
      if (!worker) return fail(fixture('versions-missing.stderr.txt').replaceAll('ep-smoke-sample', name));
      return ok(
        worker.regular
          ? '[{"id":"11111111-1111-1111-1111-111111111111"}]\n'
          : fixture('versions-previews-only.stdout.txt'),
      );
    }
    if (command === 'delete') {
      const name = flag(args, '--name') ?? '';
      if (!this.workers.delete(name))
        return fail(fixture('versions-missing.stderr.txt').replaceAll('ep-smoke-sample', name));
      return ok(fixture('worker-delete.stdout.txt').replaceAll('ep-smoke-sample', name));
    }
    if (command === 'preview' && sub === 'delete') return this.deletePreview(args);
    if (command === 'preview' && sub === 'secret') return this.listPreviewSecrets(args);
    if (command === 'preview') return this.createPreview(args, options);
    return fail(`X [ERROR] Unknown command ${args.join(' ')}\n`);
  }

  private notFound(name: string): CliResult {
    return fail(fixture('preview-missing.stderr.txt').replaceAll('"nope"', `"${name}"`));
  }

  private deletePreview(args: string[]): CliResult {
    const name = flag(args, '--name') ?? '';
    const worker = this.workers.get(flag(args, '--worker-name') ?? '');
    if (!worker?.previews.delete(name)) return this.notFound(name);
    return ok(fixture('preview-delete.stdout.txt').replace('"sample"', `"${name}"`));
  }

  private listPreviewSecrets(args: string[]): CliResult {
    const name = flag(args, '--name') ?? '';
    const preview = this.workers.get(flag(args, '--worker-name') ?? '')?.previews.get(name);
    return preview ? ok(fixture('preview-secret-list.stdout.txt')) : this.notFound(name);
  }

  private async createPreview(args: string[], options: WranglerRunOptions): Promise<CliResult> {
    const name = flag(args, '--name') ?? '';
    const workerName = flag(args, '--worker-name') ?? '';
    if (!/^[A-Za-z0-9]$|^[A-Za-z0-9][A-Za-z0-9_.-]*[A-Za-z0-9]$/.test(name)) {
      return fail(`X [ERROR] A request to the Cloudflare API failed.\n\n  Invalid preview name [code: 10003]\n`);
    }

    let worker = this.workers.get(workerName);
    if (!worker) {
      if (this.creating.has(workerName)) {
        return fail(
          `X [ERROR] A request to the Cloudflare API failed.\n\n  A Worker with the name '${workerName}' already exists. [code: 10040]\n`,
        );
      }
      this.creating.add(workerName);
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
      worker = { regular: false, previews: new Map() };
      this.workers.set(workerName, worker);
      this.creating.delete(workerName);
    } else {
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    }

    const secretsFile = flag(args, '--secrets-file');
    const secrets = secretsFile ? await this.fs.readText(secretsFile) : null;
    const stored = (JSON.parse(secrets ?? '{}') as { SECRET?: string }).SECRET ?? '';
    const vars: Record<string, string> = {};
    args.forEach((arg, i) => {
      if (arg !== '--var') return;
      const [key, ...rest] = (args[i + 1] ?? '').split(':');
      if (key) vars[key] = rest.join(':');
    });
    const bundle = options.cwd ? await this.fs.readText(joinPath(this.platform, options.cwd, 'worker.js')) : null;
    const codeVersion = /code version (\S+)/.exec(bundle ?? '')?.[1] ?? '0';

    const existing = worker.previews.get(name);
    let slug = existing?.slug ?? this.slugFor(name, workerName);
    if (!existing && [...worker.previews.values()].some((p) => p.slug === slug)) slug = `${slug}-${'abcd'}`;
    const preview: FakePreview = {
      id: existing?.id ?? (++this.idCounter).toString(16).padStart(32, '0'),
      slug,
      name,
      vars,
      secret: this.corruptStoredSecret ? `${stored}-corrupted` : stored,
      codeVersion,
    };
    worker.previews.set(name, preview);

    const body = JSON.parse(fixture('preview-create.stdout.json')) as { preview: Record<string, unknown> };
    Object.assign(body.preview, { id: preview.id, slug, name, urls: [this.urlOf(workerName, slug)] });
    return ok(JSON.stringify(body, null, 2));
  }

  private find(url: string): { workerName: string; preview: FakePreview } | undefined {
    const host = new URL(url).hostname;
    for (const [workerName, worker] of this.workers) {
      for (const preview of worker.previews.values()) {
        if (host === `${preview.slug}-${workerName}.${this.subdomain}.workers.dev`) return { workerName, preview };
      }
    }
    return undefined;
  }

  private async version(url: string): Promise<RelayVersionProbe> {
    if (this.unreachable) return { kind: 'unreachable', error: 'connection refused' };
    if (this.notReadyVersionProbes > 0) {
      this.notReadyVersionProbes--;
      return { kind: 'other', status: 404 };
    }
    if (this.shadowed.has(new URL(url).hostname)) return { kind: 'other', status: 200 };
    const found = this.find(url);
    if (!found) return { kind: 'other', status: 404 };
    return {
      kind: 'relay',
      name: 'everport-relay',
      codeVersion: found.preview.codeVersion,
      tunnel: found.preview.vars['TUNNEL'] ?? null,
    };
  }

  private async handshake(url: string, token: string): Promise<number> {
    this.handshakes.push(url);
    if (this.unreachable) return 0;
    if (this.notReadyHandshakes > 0) {
      this.notReadyHandshakes--;
      return 404;
    }
    const found = this.find(url);
    if (!found) return 404;
    return token === (await connectToken(found.preview.secret, found.preview.vars['TUNNEL'] ?? '')) ? 101 : 403;
  }
}
