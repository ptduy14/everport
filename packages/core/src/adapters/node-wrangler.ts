import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { CliResult, WranglerRunOptions, WranglerRunner } from '../ports.js';
import { WRANGLER_VERSION, workerdMissing } from '../relay/wrangler.js';
import { NodeProcessTable, quoteForCmd } from './node-process-table.js';

export interface NpxCommand {
  command: string;
  /** Arguments that go before `-y wrangler@...`. */
  prefix: string[];
  shell: boolean;
}

/**
 * How to run npx. `npx-cli.js` sits next to the node binary, and running it with node avoids a shell: on current Node
 * versions spawning `npx.cmd` directly fails (EINVAL), and through a shell every argument would need quoting.
 */
export function resolveNpx(
  nodePath: string = process.execPath,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): NpxCommand {
  const path = platform === 'win32' ? win32 : posix; // the target platform's rules, whatever runs this code
  const dir = path.dirname(nodePath);
  const cli =
    platform === 'win32'
      ? path.join(dir, 'node_modules', 'npm', 'bin', 'npx-cli.js')
      : path.join(dir, '..', 'lib', 'node_modules', 'npm', 'bin', 'npx-cli.js');
  if (exists(cli)) return { command: nodePath, prefix: [cli], shell: false };
  return platform === 'win32'
    ? { command: 'npx.cmd', prefix: [], shell: true }
    : { command: 'npx', prefix: [], shell: false };
}

/** The full argument list for npx. Through a shell (the `npx.cmd` fallback) each one is quoted for cmd. */
export function npxArgs(npx: NpxCommand, version: string, args: string[]): string[] {
  const all = [...npx.prefix, '-y', `wrangler@${version}`, ...args];
  return npx.shell ? all.map(quoteForCmd) : all;
}

/**
 * Puts the chosen node's folder first on PATH. npx starts wrangler through its `node` shim, which looks `node` up on
 * PATH: without this, an editor that starts without the user's shell PATH (fnm, nvm) runs wrangler on another Node.
 */
export function withNodeOnPath(
  env: NodeJS.ProcessEnv,
  nodePath: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const path = platform === 'win32' ? win32 : posix;
  const dir = path.dirname(nodePath);
  if (dir === '.') return env; // a bare "node": the PATH is already what resolves it
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'; // Windows spells it "Path"
  const separator = platform === 'win32' ? ';' : ':';
  return { ...env, [key]: env[key] ? `${dir}${separator}${env[key]}` : dir };
}

/**
 * The npx folder of the pinned wrangler, read from the PATH that npx gives the command it runs: its
 * `<cache>/_npx/<hash>/node_modules/.bin` comes first. Undefined when the PATH has no such entry.
 */
export function npxDirFromPath(pathValue: string, platform: NodeJS.Platform = process.platform): string | undefined {
  const path = platform === 'win32' ? win32 : posix;
  for (const entry of pathValue.trim().split(platform === 'win32' ? ';' : ':')) {
    if (/[\\/]_npx[\\/][0-9a-f]+[\\/]node_modules[\\/]\.bin[\\/]?$/i.test(entry))
      return path.resolve(entry, '..', '..');
  }
  return undefined;
}

/** The entry script of wrangler inside an npx folder. */
export const wranglerScript = (npxDir: string, platform: NodeJS.Platform = process.platform): string =>
  (platform === 'win32' ? win32 : posix).join(npxDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

/** The environment for wrangler. Never a debug log level: wrangler then writes logs to stdout, which breaks `--json`. */
export function wranglerEnv(env: NodeJS.ProcessEnv, interactive: boolean): NodeJS.ProcessEnv {
  const out = { ...env };
  for (const key of Object.keys(out)) if (key.toUpperCase() === 'WRANGLER_LOG') delete out[key];
  if (interactive) delete out['CI'];
  else out['CI'] = '1';
  return out;
}

export interface NodeWranglerOptions {
  /** Remembers where npx installed the pinned wrangler, so later processes start it without npx. */
  stateFile?: string;
  /** Called when wrangler must be prepared first: the first time on a computer it is downloaded. */
  onPreparing?: (message: string) => void;
  /** How long preparing (downloading) may take. Default 5 minutes. */
  prepareTimeoutMs?: number;
}

export const PREPARING_MESSAGE =
  "Preparing Cloudflare's wrangler. The first time on this computer it is downloaded, which takes about a minute.";

interface Prepared {
  /** wrangler.js inside the npx folder. Undefined: run through npx, the fallback. */
  script?: string;
  npxDir?: string;
}

/**
 * Runs the pinned wrangler. The first run on a computer has npx install it, with a long time limit of its own, and
 * notes where; every later run starts wrangler with node directly, about 2 s faster per command. An install without
 * workerd's binary is removed and installed again, once. When any of this fails, it runs wrangler through npx.
 * Always with CI=1 unless the run is interactive.
 */
export class NodeWranglerRunner implements WranglerRunner {
  private prepared: Promise<Prepared> | undefined;

  constructor(
    private readonly version: string = WRANGLER_VERSION,
    private readonly nodePath: string = process.execPath,
    private readonly platform: NodeJS.Platform = process.platform,
    private readonly options: NodeWranglerOptions = {},
  ) {}

  async run(args: string[], options: WranglerRunOptions = {}): Promise<CliResult> {
    if (options.signal?.aborted) return { code: 130, stdout: '', stderr: 'cancelled' };
    const prepared = await this.prepare();
    const result = await this.spawnWrangler(prepared, args, options);
    if (!prepared.npxDir || !workerdMissing(result)) return result;
    return this.spawnWrangler(await this.repair(prepared.npxDir), args, options);
  }

  private prepare(): Promise<Prepared> {
    if (!this.prepared) {
      const known = this.readState();
      this.prepared = known ? Promise.resolve(known) : this.announceAndInstall();
    }
    return this.prepared;
  }

  private announceAndInstall(): Promise<Prepared> {
    this.options.onPreparing?.(PREPARING_MESSAGE);
    return this.install();
  }

  /** Has npx install (or find) the pinned wrangler and say where it is. */
  private async install(): Promise<Prepared> {
    const result = await this.spawnNpx(['-p', `wrangler@${this.version}`, 'node', '-p', 'process.env.PATH'], {
      timeoutMs: this.options.prepareTimeoutMs ?? 5 * 60_000,
    });
    const npxDir = result.code === 0 ? npxDirFromPath(result.stdout, this.platform) : undefined;
    if (!npxDir || !this.installedVersionIs(npxDir)) return {};
    const prepared = { script: wranglerScript(npxDir, this.platform), npxDir };
    if (await this.workerdLoads(npxDir)) this.writeState(npxDir); // a broken one is repaired by run() on first use
    return prepared;
  }

  /** Removes an install that lacks workerd's binary and installs it again, once. */
  private repair(npxDir: string): Promise<Prepared> {
    this.forgetState();
    if (/[\\/]_npx[\\/][0-9a-f]+$/i.test(npxDir)) rmSync(npxDir, { recursive: true, force: true }); // npx's own folder only
    this.prepared = this.announceAndInstall();
    return this.prepared;
  }

  private join(...parts: string[]): string {
    return (this.platform === 'win32' ? win32 : posix).join(...parts);
  }

  private installedVersionIs(npxDir: string): boolean {
    try {
      const file = this.join(npxDir, 'node_modules', 'wrangler', 'package.json');
      return (JSON.parse(readFileSync(file, 'utf8')) as { version?: string }).version === this.version;
    } catch {
      return false;
    }
  }

  /** Loading workerd's entry throws at once when the binary for this platform is missing. */
  private async workerdLoads(npxDir: string): Promise<boolean> {
    const entry = this.join(npxDir, 'node_modules', 'workerd', 'lib', 'main.js');
    const result = await this.spawnProcess(this.nodePath, ['-e', 'require(process.argv[1])', entry], false, {
      timeoutMs: 30_000,
    });
    return result.code === 0;
  }

  private readState(): Prepared | undefined {
    const file = this.options.stateFile;
    if (!file) return undefined;
    try {
      const state = JSON.parse(readFileSync(file, 'utf8')) as { version?: string; npxDir?: string };
      if (state.version !== this.version || !state.npxDir) return undefined;
      const script = wranglerScript(state.npxDir, this.platform);
      return existsSync(script) ? { script, npxDir: state.npxDir } : undefined;
    } catch {
      return undefined;
    }
  }

  private writeState(npxDir: string): void {
    const file = this.options.stateFile;
    if (!file) return;
    try {
      mkdirSync((this.platform === 'win32' ? win32 : posix).dirname(file), { recursive: true });
      writeFileSync(file, `${JSON.stringify({ version: this.version, npxDir }, null, 2)}\n`);
    } catch {
      // only a speed-up: the next process asks npx again
    }
  }

  private forgetState(): void {
    if (this.options.stateFile) rmSync(this.options.stateFile, { force: true });
  }

  private spawnWrangler(prepared: Prepared, args: string[], options: WranglerRunOptions): Promise<CliResult> {
    if (prepared.script) return this.spawnProcess(this.nodePath, [prepared.script, ...args], false, options);
    const npx = resolveNpx(this.nodePath, this.platform);
    return this.spawnProcess(npx.command, npxArgs(npx, this.version, args), npx.shell, options);
  }

  private spawnNpx(args: string[], options: WranglerRunOptions): Promise<CliResult> {
    const npx = resolveNpx(this.nodePath, this.platform);
    const all = [...npx.prefix, '-y', ...args];
    return this.spawnProcess(npx.command, npx.shell ? all.map(quoteForCmd) : all, npx.shell, options);
  }

  private spawnProcess(
    command: string,
    args: string[],
    shell: boolean,
    options: WranglerRunOptions,
  ): Promise<CliResult> {
    if (options.signal?.aborted) return Promise.resolve({ code: 130, stdout: '', stderr: 'cancelled' });
    const env = wranglerEnv(
      withNodeOnPath({ ...process.env, ...options.env }, this.nodePath, this.platform),
      options.interactive === true,
    );
    return new Promise((resolve) => {
      const child = spawn(command, args, {
        cwd: options.cwd,
        env,
        shell,
        stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'],
        windowsHide: !options.interactive,
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => (stderr += chunk.toString()));

      const timer = options.timeoutMs
        ? setTimeout(() => {
            if (child.pid) void new NodeProcessTable(this.platform).killTree(child.pid);
            resolve({ code: 124, stdout, stderr: `${stderr}\nwrangler did not finish in ${options.timeoutMs} ms` });
          }, options.timeoutMs)
        : undefined;
      const onAbort = () => {
        clearTimeout(timer);
        if (child.pid) void new NodeProcessTable(this.platform).killTree(child.pid);
        resolve({ code: 130, stdout, stderr: `${stderr}\ncancelled` });
      };
      options.signal?.addEventListener('abort', onAbort, { once: true });
      const done = () => {
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', onAbort);
      };

      child.on('error', (e) => {
        done();
        resolve({ code: 127, stdout, stderr: `${stderr}\n${e.message}` });
      });
      child.on('close', (code) => {
        done();
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
