import { NodeFileSystem, NodeProcessTable } from '@everport/core';
import { FakeRelay } from '@everport/relay/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { ProcessAgentControl } from './agent-control.js';
import { createEverport } from './create-everport.js';
import { runDaemon } from './daemon.js';
import type { LauncherDeps } from './launcher.js';
import { FakeProcessTable, makeLayout } from './testing/daemon-helpers.js';
import { FAST, SECRET, silentLogger, sleep, waitFor } from './testing/helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const SPAWNED_PID = 777;

/** As in the launcher tests: "spawning" starts the daemon inside the test process. */
async function setup() {
  const layout = await makeLayout(cleanup);
  const fs = new NodeFileSystem();
  const processTable = new FakeProcessTable();
  processTable.alive.add(process.pid);
  processTable.onSpawn = async () => {
    const daemon = await runDaemon({
      layout,
      fs,
      logger: silentLogger,
      pid: SPAWNED_PID,
      processTable: new NodeProcessTable(),
      timings: FAST,
      onExit: () => void processTable.alive.delete(SPAWNED_PID),
    });
    cleanup.push(() => daemon.shutdown());
    processTable.alive.add(SPAWNED_PID);
    return SPAWNED_PID;
  };
  const deps: LauncherDeps = {
    fs,
    processTable,
    layout,
    nodePath: 'node',
    entryPath: '/agent.js',
    startTimeoutMs: 1500,
    pollMs: 20,
  };
  return { control: new ProcessAgentControl(deps), processTable };
}

describe('ProcessAgentControl', () => {
  it('reports no agent while none runs, and refuses to add a tunnel to it', async () => {
    const { control } = await setup();
    expect(await control.status()).toBeNull();
    expect(await control.removeTunnel('fe')).toBe(false);
    await expect(
      control.addTunnel({ name: 'fe', url: 'http://127.0.0.1:1', target: 'http://127.0.0.1:2' }),
    ).rejects.toMatchObject({
      code: 'AGENT_NOT_RUNNING',
    });
  });

  it('starts the agent once, however often it is asked', async () => {
    const { control, processTable } = await setup();
    await control.ensureRunning();
    await control.ensureRunning();
    expect(processTable.spawned).toHaveLength(1);
    expect(await control.status()).toEqual({ pid: SPAWNED_PID, tunnels: [] });
  });

  it('serves tunnels and reports each one with its state', async () => {
    const { control } = await setup();
    const relay = new FakeRelay({ secret: SECRET, tunnel: 'fe' });
    const base = await relay.start();
    cleanup.push(() => relay.stop());

    await control.ensureRunning();
    await control.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.connectedAgents === 1);
    const until = Date.now() + 3000;
    let info = await control.status();
    while (info!.tunnels[0]?.state !== 'connected' && Date.now() < until) {
      await sleep(20);
      info = await control.status();
    }
    expect(info!.tunnels).toEqual([{ name: 'fe', state: 'connected' }]);

    expect(await control.removeTunnel('fe')).toBe(true);
    expect(await control.removeTunnel('fe')).toBe(false);
    expect((await control.status())!.tunnels).toEqual([]);
  });

  it('reports why a tunnel is not connected', async () => {
    const { control } = await setup();
    const relay = new FakeRelay({ secret: 'a-different-secret', tunnel: 'fe' });
    const base = await relay.start();
    cleanup.push(() => relay.stop());
    await control.ensureRunning();
    await control.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await sleep(300);
    const [tunnel] = (await control.status())!.tunnels;
    expect(tunnel).toMatchObject({ name: 'fe', state: 'connecting' });
    expect(tunnel!.lastError).toBeTruthy();
  });

  it('stops the agent', async () => {
    const { control } = await setup();
    await control.ensureRunning();
    expect(await control.stop()).toBe('stopped');
    expect(await control.status()).toBeNull();
    expect(await control.stop()).toBe('not-running');
  });
});

describe('createEverport', () => {
  it('builds a facade on the real parts: an empty data folder has no tunnels and no agent', async () => {
    const layout = await makeLayout(cleanup, false);
    const everport = createEverport({
      dataDir: layout.dataDir,
      workerFile: '/none/worker.js',
      agentEntry: '/none/agent.js',
    });
    expect(everport.dataDir).toBe(layout.dataDir);
    expect(await everport.status()).toEqual([]);
    expect(await everport.down()).toBe('not-running');
  });
});
