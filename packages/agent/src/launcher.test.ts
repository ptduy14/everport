import { NodeFileSystem, NodeProcessTable } from '@everport/core';
import { afterEach, describe, expect, it } from 'vitest';
import { runDaemon, type Daemon } from './daemon.js';
import { findAgent, startAgent, stopAgent, type LauncherDeps } from './launcher.js';
import { writeAgentState } from './state.js';
import { FakeProcessTable, makeLayout } from './testing/daemon-helpers.js';
import { FAST, silentLogger } from './testing/helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

const SPAWNED_PID = 777;

/**
 * A launcher whose "spawn" starts the daemon inside the test process, recording the fake pid 777 as its own.
 * The test process stays alive in the fake table for good: it owns the start lock, as a real launcher would.
 */
async function setup(over: Partial<LauncherDeps> = {}) {
  const layout = await makeLayout(cleanup);
  const fs = new NodeFileSystem();
  const processTable = new FakeProcessTable();
  processTable.alive.add(process.pid);
  const daemons: Daemon[] = [];
  processTable.onSpawn = async () => {
    const daemon = await runDaemon({
      layout,
      fs,
      logger: silentLogger,
      pid: SPAWNED_PID,
      processTable: new NodeProcessTable(),
      timings: FAST,
      onExit: () => {
        processTable.alive.delete(SPAWNED_PID);
      },
    });
    daemons.push(daemon);
    cleanup.push(() => daemon.shutdown());
    processTable.alive.add(SPAWNED_PID);
    return SPAWNED_PID;
  };
  const deps: LauncherDeps = {
    fs,
    processTable,
    layout,
    nodePath: 'node',
    entryPath: '/path/to/agent.js',
    startTimeoutMs: 1500,
    pollMs: 20,
    ...over,
  };
  return { layout, fs, processTable, daemons, deps };
}

describe('startAgent', () => {
  it('spawns the agent detached with the data dir and returns a working client', async () => {
    const { deps, processTable, layout } = await setup();
    const client = await startAgent(deps);
    expect((await client.status()).pid).toBe(SPAWNED_PID);
    expect(processTable.spawned).toEqual([
      { cmd: 'node', args: ['/path/to/agent.js', '--data-dir', layout.dataDir], logFile: layout.agentOutFile },
    ]);
  });

  it('does nothing more when an agent is already running', async () => {
    const { deps, processTable } = await setup();
    await startAgent(deps);
    await startAgent(deps);
    expect(processTable.spawned).toHaveLength(1);
  });

  it('starts one agent when two callers ask at the same time', async () => {
    const { deps, processTable } = await setup();
    const [a, b] = await Promise.all([startAgent(deps), startAgent(deps)]);
    expect(processTable.spawned).toHaveLength(1);
    expect((await a.status()).pid).toBe((await b.status()).pid);
  });

  it('gives up, and kills what it spawned, when the agent never answers', async () => {
    const { deps, processTable } = await setup({ startTimeoutMs: 200 });
    processTable.onSpawn = () => {
      processTable.alive.add(555);
      return 555;
    };
    await expect(startAgent(deps)).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(processTable.killed).toEqual([555]);
  });

  it('fails fast and quotes the agent output when the agent dies right away', async () => {
    const { deps, processTable, fs, layout } = await setup({ startTimeoutMs: 5000 });
    processTable.onSpawn = async () => {
      await fs.appendText(layout.agentOutFile, 'The relay secret is missing\n');
      return 556; // not in the alive set: the process is already gone
    };
    const started = Date.now();
    await expect(startAgent(deps)).rejects.toMatchObject({
      code: 'AGENT_NOT_RUNNING',
      message: expect.stringContaining('The relay secret is missing'),
    });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('refuses to start a second agent next to a live one that does not answer', async () => {
    const { deps, processTable, fs, layout } = await setup();
    await writeAgentState(fs, layout.agentStateFile, { pid: 4242, port: 1, token: 't', startedAt: 1 });
    processTable.alive.add(4242);
    await expect(startAgent(deps)).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
    expect(processTable.spawned).toHaveLength(0);
  });
});

describe('findAgent', () => {
  it('finds nothing when there is no agent.json', async () => {
    const { deps } = await setup();
    expect(await findAgent(deps)).toBeNull();
  });

  it('removes an agent.json whose process is gone', async () => {
    const { deps, fs, layout } = await setup();
    await writeAgentState(fs, layout.agentStateFile, { pid: 4242, port: 1, token: 't', startedAt: 1 });
    expect(await findAgent(deps)).toBeNull();
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });

  it('ignores and removes an agent.json from before a restart, even when its pid now belongs to another process', async () => {
    const { deps, fs, layout, processTable } = await setup();
    const boot = Date.now() - 10 * 60_000;
    processTable.bootTime = () => boot;
    await writeAgentState(fs, layout.agentStateFile, { pid: 4244, port: 1, token: 't', startedAt: boot - 3_600_000 });
    processTable.alive.add(4244);
    expect(await findAgent(deps)).toBeNull();
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });

  it('finds the agent that is running', async () => {
    const { deps } = await setup();
    const started = await startAgent(deps);
    const found = await findAgent(deps);
    expect(found?.connection).toEqual(started.connection);
  });
});

describe('stopAgent', () => {
  it('asks the agent to stop and reports that it did', async () => {
    const { deps, processTable, fs, layout } = await setup();
    await startAgent(deps);
    expect(await stopAgent(deps, { timeoutMs: 2000, pollMs: 20 })).toBe('stopped');
    expect(processTable.alive.has(SPAWNED_PID)).toBe(false);
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });

  it('kills an agent that stays alive after being asked', async () => {
    const { deps, processTable, fs, layout } = await setup();
    await writeAgentState(fs, layout.agentStateFile, { pid: 4243, port: 1, token: 't', startedAt: 1 });
    processTable.alive.add(4243);
    expect(await stopAgent(deps, { timeoutMs: 200, pollMs: 20 })).toBe('killed');
    expect(processTable.killed).toEqual([4243]);
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });

  it('logs that it killed the agent', async () => {
    const { deps, fs, layout, processTable } = await setup();
    await writeAgentState(fs, layout.agentStateFile, { pid: 4247, port: 1, token: 't', startedAt: 1 });
    processTable.alive.add(4247);
    await stopAgent(deps, { timeoutMs: 100, pollMs: 20 });
    expect(await fs.readText(layout.agentLogFile)).toContain('agent (pid 4247) did not stop when asked: killed it');
  });

  it('never kills by a pid recorded before a restart', async () => {
    const { deps, fs, layout, processTable } = await setup();
    const boot = Date.now() - 10 * 60_000;
    processTable.bootTime = () => boot;
    await writeAgentState(fs, layout.agentStateFile, { pid: 4245, port: 1, token: 't', startedAt: boot - 3_600_000 });
    processTable.alive.add(4245);
    expect(await stopAgent(deps, { timeoutMs: 200, pollMs: 20 })).toBe('not-running');
    expect(processTable.killed).toEqual([]);
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });

  it('says not-running when there is no agent, or only a stale agent.json', async () => {
    const { deps, fs, layout } = await setup();
    expect(await stopAgent(deps)).toBe('not-running');
    await writeAgentState(fs, layout.agentStateFile, { pid: 4242, port: 1, token: 't', startedAt: 1 });
    expect(await stopAgent(deps)).toBe('not-running');
    expect(await fs.exists(layout.agentStateFile)).toBe(false);
  });
});
