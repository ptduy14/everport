import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import type { CliResult, WranglerRunOptions, WranglerRunner } from '../ports.js';
import { WRANGLER_VERSION } from '../relay/wrangler.js';
import { NodeProcessTable } from './node-process-table.js';

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

/** Runs the pinned wrangler through npx. Always with CI=1 unless the run is interactive. */
export class NodeWranglerRunner implements WranglerRunner {
  constructor(
    private readonly version: string = WRANGLER_VERSION,
    private readonly nodePath: string = process.execPath,
    private readonly platform: NodeJS.Platform = process.platform,
  ) {}

  run(args: string[], options: WranglerRunOptions = {}): Promise<CliResult> {
    const npx = resolveNpx(this.nodePath, this.platform);
    const env: NodeJS.ProcessEnv = withNodeOnPath({ ...process.env, ...options.env }, this.nodePath, this.platform);
    if (options.interactive) delete env['CI'];
    else env['CI'] = '1';

    return new Promise((resolve) => {
      const child = spawn(npx.command, [...npx.prefix, '-y', `wrangler@${this.version}`, ...args], {
        cwd: options.cwd,
        env,
        shell: npx.shell,
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

      child.on('error', (e) => {
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: `${stderr}\n${e.message}` });
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      });
    });
  }
}
