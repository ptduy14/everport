// Helpers for the end-to-end tests: build the relay Worker, run it in workerd, and talk to wrangler.
import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { mkdir, mkdtemp, rm, copyFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NodeProcessTable, resolveNpx } from '@everport/core';
import { renderWranglerConfig } from '@everport/relay';

export const WRANGLER_VERSION = '4.166.0';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const relayDir = join(root, 'packages', 'relay');
const tsupCli = join(root, 'node_modules', 'tsup', 'dist', 'cli-default.js');
/** How to run npx: through node itself where possible (spawning npx.cmd directly fails with EINVAL on Windows). */
const npx = resolveNpx();

/** Builds the relay Worker bundle and returns the path of dist/worker.js. */
export function buildWorker(): string {
  execFileSync(process.execPath, [tsupCli], { cwd: relayDir, stdio: 'pipe' });
  return join(relayDir, 'dist', 'worker.js');
}

export async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export interface WorkerdRelay {
  /** e.g. http://127.0.0.1:8787 */
  url: string;
  stop(): Promise<void>;
}

/** Runs the built Worker in the local Cloudflare runtime with `wrangler dev`. No Cloudflare account needed. */
export async function startWorkerd(options: {
  workerFile: string;
  tunnel: string;
  secret: string;
}): Promise<WorkerdRelay> {
  const dir = await mkdtemp(join(tmpdir(), 'everport-workerd-'));
  await mkdir(dir, { recursive: true });
  await copyFile(options.workerFile, join(dir, 'worker.js'));
  await writeFile(join(dir, 'wrangler.toml'), renderWranglerConfig({ workerName: 'ep-local-test' }));

  const port = await freePort();
  const child: ChildProcess = spawn(
    npx.command,
    [
      ...npx.prefix,
      '-y',
      `wrangler@${WRANGLER_VERSION}`,
      'dev',
      '--ip',
      '127.0.0.1',
      '--port',
      String(port),
      '--var',
      `TUNNEL:${options.tunnel}`,
      '--var',
      `SECRET:${options.secret}`,
    ],
    {
      cwd: dir,
      env: { ...process.env, CI: '1' },
      shell: npx.shell,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  const processTable = new NodeProcessTable();
  const stop = async () => {
    if (child.pid && processTable.isAlive(child.pid)) await processTable.killTree(child.pid);
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  };

  let output = '';
  try {
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        output += chunk.toString();
        if (/Ready on http/.test(output)) resolve();
      };
      child.stdout!.on('data', onData);
      child.stderr!.on('data', onData);
      child.on('exit', (code) => reject(new Error(`wrangler dev exited (${code}) before it was ready:\n${output}`)));
      setTimeout(() => reject(new Error(`wrangler dev was not ready in time:\n${output}`)), 150_000);
    });
  } catch (e) {
    await stop();
    throw e;
  }
  return { url: `http://127.0.0.1:${port}`, stop };
}
