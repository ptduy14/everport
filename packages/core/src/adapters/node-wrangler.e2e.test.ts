// Real wrangler, to confirm what CI=1 does and does not change. Run with `npm run test:e2e`.
// Nothing here creates or deletes anything on Cloudflare: only `whoami` and a `versions list` of a Worker that does not exist.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CliResult } from '../ports.js';
import { WRANGLER_VERSION, isAuthFailure, parseLoggedIn, parseWorkerState } from '../relay/wrangler.js';
import { NodeWranglerRunner, resolveNpx } from './node-wrangler.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

/** The same command as the runner issues, but without CI=1, to compare with it. */
function runWithoutCi(args: string[], env: Record<string, string> = {}): Promise<CliResult> {
  const npx = resolveNpx();
  const full: NodeJS.ProcessEnv = { ...process.env, ...env };
  delete full['CI'];
  return new Promise((resolve) => {
    const child = spawn(npx.command, [...npx.prefix, '-y', `wrangler@${WRANGLER_VERSION}`, ...args], {
      env: full,
      shell: npx.shell,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c));
    child.stderr.on('data', (c: Buffer) => (stderr += c));
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

const runner = new NodeWranglerRunner();
const MISSING = ['versions', 'list', '--name', 'ep-ci-check-does-not-exist', '--json'];

describe('wrangler without a login (an empty config folder), with CI=1', () => {
  async function loggedOutEnv() {
    const dir = await mkdtemp(join(tmpdir(), 'everport-nologin-'));
    dirs.push(dir);
    return { XDG_CONFIG_HOME: dir };
  }

  it('answers `whoami --json` with loggedIn false and exit 1, without opening a browser or asking anything', async () => {
    const started = Date.now();
    const result = await runner.run(['whoami', '--json'], { env: await loggedOutEnv(), timeoutMs: 120_000 });
    expect(result.code).toBe(1);
    expect(parseLoggedIn(result)).toBe(false);
    console.log(`[measure] logged-out whoami with CI=1 answered after ${Date.now() - started} ms`);
  });

  it('fails a real command quickly with a login error that Everport recognises', async () => {
    const result = await runner.run(MISSING, { env: await loggedOutEnv(), timeoutMs: 120_000 });
    expect(result.code).not.toBe(0);
    expect(isAuthFailure(result)).toBe(true);
    expect(() => parseWorkerState(result)).toThrowError(expect.objectContaining({ code: 'NOT_LOGGED_IN' }));
  });
});

describe('wrangler with the login of this machine: CI=1 against no CI', () => {
  it('gives the same answers to the commands Everport reads', async (context) => {
    const withCi = await runner.run(['whoami', '--json'], { timeoutMs: 120_000 });
    if (!(withCi.code === 0 && parseLoggedIn(withCi))) return context.skip();

    const withoutCi = await runWithoutCi(['whoami', '--json']);
    expect(withoutCi.code).toBe(withCi.code);
    expect(Object.keys(JSON.parse(withoutCi.stdout)).sort()).toEqual(Object.keys(JSON.parse(withCi.stdout)).sort());

    const missingWithCi = await runner.run(MISSING, { timeoutMs: 120_000 });
    const missingWithoutCi = await runWithoutCi(MISSING);
    expect(missingWithoutCi.code).toBe(missingWithCi.code);
    expect(parseWorkerState(missingWithCi)).toBe('none');
    expect(parseWorkerState(missingWithoutCi)).toBe('none');
    expect(missingWithCi.stderr).toContain('[code: 10007]');
    expect(missingWithoutCi.stderr).toContain('[code: 10007]');
  });
});
