// The real thing: the agent bundled by tsup, started detached with spawnDetached, controlled over its API.
// Slow (a build and a real process), and the one place that proves the detached start works on this OS.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { NodeFileSystem, NodeProcessTable } from '@everport/core';
import { FakeRelay } from '@everport/relay/testing';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { readAgentState } from './state.js';
import { findAgent, startAgent, stopAgent, type LauncherDeps } from './launcher.js';
import { makeLayout } from './testing/daemon-helpers.js';
import { SECRET, startOrigin, waitFor } from './testing/helpers.js';

const packageDir = fileURLToPath(new URL('..', import.meta.url));
const entryPath = fileURLToPath(new URL('../dist/agent.js', import.meta.url));
const tsupCli = fileURLToPath(new URL('../../../node_modules/tsup/dist/cli-default.js', import.meta.url));
const esbuildCli = fileURLToPath(new URL('../../../node_modules/esbuild/bin/esbuild', import.meta.url));
const hostSource = fileURLToPath(new URL('./testing/host.ts', import.meta.url));
const hostPath = fileURLToPath(new URL('../dist-test/host.mjs', import.meta.url));

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

beforeAll(() => {
  execFileSync(process.execPath, [tsupCli], { cwd: packageDir, stdio: 'pipe' });
  expect(existsSync(entryPath)).toBe(true);
  execFileSync(
    process.execPath,
    [esbuildCli, hostSource, '--bundle', '--platform=node', '--format=esm', '--target=node22', `--outfile=${hostPath}`],
    { cwd: packageDir, stdio: 'pipe' },
  );
  expect(existsSync(hostPath)).toBe(true);
}, 60_000);

const fs = new NodeFileSystem();
const processTable = new NodeProcessTable();

/** Whatever happens in a test, never leave an agent process behind. */
async function killLeftover(agentStateFile: string) {
  const state = await readAgentState(fs, agentStateFile);
  if (state && processTable.isAlive(state.pid)) await processTable.killTree(state.pid);
}

describe('the real agent process', () => {
  it('starts detached, serves a tunnel, is found again, and stops cleanly', async () => {
    const layout = await makeLayout(cleanup);
    cleanup.push(() => killLeftover(layout.agentStateFile));
    const relay = new FakeRelay({ secret: SECRET, tunnel: 'fe' });
    const base = await relay.start();
    cleanup.push(() => relay.stop());
    const origin = await startOrigin((_req, res) => void res.end('from the real agent'));
    cleanup.push(() => origin.close());
    const deps: LauncherDeps = {
      fs,
      processTable,
      layout,
      nodePath: process.execPath,
      entryPath,
      startTimeoutMs: 20_000,
    };

    const client = await startAgent(deps);
    const status = await client.status();
    expect(status.pid).not.toBe(process.pid);
    expect(processTable.isAlive(status.pid)).toBe(true);

    await client.addTunnel({ name: 'fe', url: base, target: origin.url });
    await waitFor(() => relay.connectedAgents === 1, 10_000);
    expect(await (await fetch(`${base}/hello`)).text()).toBe('from the real agent');

    expect((await findAgent(deps))?.connection).toEqual(client.connection);
    expect((await startAgent(deps)).connection).toEqual(client.connection); // idempotent: no second process

    expect(await stopAgent(deps, { timeoutMs: 10_000 })).toBe('stopped');
    expect(processTable.isAlive(status.pid)).toBe(false);
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
    await waitFor(() => relay.connectedAgents === 0);
  }, 60_000);

  it('keeps serving after the process that started it is killed with its whole tree', async () => {
    const layout = await makeLayout(cleanup);
    cleanup.push(() => killLeftover(layout.agentStateFile));
    const relay = new FakeRelay({ secret: SECRET, tunnel: 'fe' });
    const base = await relay.start();
    cleanup.push(() => relay.stop());
    const origin = await startOrigin((_req, res) => void res.end('still serving'));
    cleanup.push(() => origin.close());
    const deps: LauncherDeps = {
      fs,
      processTable,
      layout,
      nodePath: process.execPath,
      entryPath,
      startTimeoutMs: 20_000,
    };

    const host = spawn(process.execPath, [hostPath, '--data-dir', layout.dataDir, '--entry', entryPath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    cleanup.push(() => processTable.killTree(host.pid!));
    const agentPid = await new Promise<number>((resolve, reject) => {
      let output = '';
      host.stdout.on('data', (chunk) => {
        output += String(chunk);
        const ready = /ready (\d+)/.exec(output);
        if (ready) resolve(Number(ready[1]));
      });
      host.stderr.on('data', (chunk) => (output += String(chunk)));
      host.on('exit', (code) => reject(new Error(`the host exited early (${code}): ${output}`)));
      setTimeout(() => reject(new Error(`the host did not report ready: ${output}`)), 30_000);
    });
    expect(agentPid).not.toBe(host.pid);

    await processTable.killTree(host.pid!); // what closing the terminal or VS Code does
    await waitFor(() => !processTable.isAlive(host.pid!), 10_000);

    expect(processTable.isAlive(agentPid)).toBe(true);
    const client = await findAgent(deps);
    expect(client).not.toBeNull();
    await client!.addTunnel({ name: 'fe', url: base, target: origin.url });
    await waitFor(() => relay.connectedAgents === 1, 10_000);
    expect(await (await fetch(`${base}/after`)).text()).toBe('still serving');

    expect(await stopAgent(deps, { timeoutMs: 10_000 })).toBe('stopped');
    expect(processTable.isAlive(agentPid)).toBe(false);
  }, 90_000);

  it('fails with the reason when the agent cannot start', async () => {
    const layout = await makeLayout(cleanup, false); // no relay secret
    cleanup.push(() => killLeftover(layout.agentStateFile));
    const deps: LauncherDeps = {
      fs,
      processTable,
      layout,
      nodePath: process.execPath,
      entryPath,
      startTimeoutMs: 20_000,
    };
    await expect(startAgent(deps)).rejects.toMatchObject({
      code: 'AGENT_NOT_RUNNING',
      message: expect.stringContaining('relay secret'),
    });
  }, 60_000);
});
