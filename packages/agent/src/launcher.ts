// Starting, finding and stopping the background agent, from the CLI or VS Code side.
import { EverportError, FileLock, type FileSystem, type Layout, type ProcessTable } from '@everport/core';
import { AgentClient } from './control-client.js';
import { readAgentState, removeAgentState } from './state.js';

export interface FindDeps {
  fs: FileSystem;
  processTable: ProcessTable;
  layout: Layout;
}

export interface LauncherDeps extends FindDeps {
  /** The Node binary that runs the agent. */
  nodePath: string;
  /** The bundled agent script (dist/agent.js). */
  entryPath: string;
  /** How long to wait for a new agent to answer. Default 10 s. */
  startTimeoutMs?: number;
  pollMs?: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The running agent, or null when none runs. A leftover agent.json whose process is gone is cleaned up.
 * Throws when the recorded process is alive but does not answer: starting a second agent would fight with it.
 */
export async function findAgent({ fs, processTable, layout }: FindDeps): Promise<AgentClient | null> {
  const state = await readAgentState(fs, layout.agentStateFile);
  if (!state) return null;
  if (!processTable.isAlive(state.pid)) {
    await removeAgentState(fs, layout.agentStateFile);
    return null;
  }
  const client = new AgentClient(state, 2000);
  try {
    await client.status();
    return client;
  } catch {
    throw new EverportError(
      'AGENT_NOT_RUNNING',
      `agent.json points to process ${state.pid}, which is running but does not answer`,
      `Stop that process, or delete ${layout.agentStateFile} if it is not an Everport agent.`,
    );
  }
}

/** The last lines the agent wrote, to say why it died. */
async function lastLines(fs: FileSystem, layout: Layout): Promise<string> {
  const lines: string[] = [];
  for (const file of [layout.agentOutFile, layout.agentLogFile]) {
    const text = await fs.readText(file).catch(() => null);
    if (text) lines.push(...text.trim().split(/\r?\n/).slice(-3));
  }
  return lines.join(' | ');
}

/**
 * Makes sure an agent is running and returns a client for it. Starting is idempotent and safe against
 * two callers at once (CLI and VS Code): one starts it, the other waits and finds it.
 */
export async function startAgent(deps: LauncherDeps): Promise<AgentClient> {
  const { fs, processTable, layout } = deps;
  const timeoutMs = deps.startTimeoutMs ?? 10_000;
  const pollMs = deps.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  const lock = new FileLock(fs, processTable, `${layout.agentStateFile}.lock`, process.pid);

  for (;;) {
    try {
      return await lock.withLock(async () => {
        const running = await findAgent(deps);
        if (running) return running;
        return spawnAndWait(deps, deadline, pollMs);
      });
    } catch (e) {
      if (!(e instanceof EverportError && e.code === 'LOCKED') || Date.now() >= deadline) throw e;
      await sleep(pollMs);
      const started = await findAgent(deps).catch(() => null);
      if (started) return started;
    }
  }
}

async function spawnAndWait(deps: LauncherDeps, deadline: number, pollMs: number): Promise<AgentClient> {
  const { fs, processTable, layout } = deps;
  await fs.appendText(layout.agentOutFile, ''); // creates the logs folder the redirect needs
  const pid = await processTable.spawnDetached(
    deps.nodePath,
    [deps.entryPath, '--data-dir', layout.dataDir],
    layout.agentOutFile,
  );

  while (Date.now() < deadline) {
    const state = await readAgentState(fs, layout.agentStateFile);
    if (state) {
      const client = new AgentClient(state, 2000);
      try {
        await client.status();
        return client;
      } catch {
        // written but not answering yet
      }
    }
    if (pid !== undefined && !processTable.isAlive(pid)) {
      throw new EverportError(
        'AGENT_NOT_RUNNING',
        `The agent exited right after starting: ${(await lastLines(fs, layout)) || 'no output'}`,
        `See ${layout.agentLogFile} and ${layout.agentOutFile}.`,
      );
    }
    await sleep(pollMs);
  }

  if (pid !== undefined) await processTable.killTree(pid);
  throw new EverportError(
    'AGENT_NOT_RUNNING',
    'The agent did not start in time',
    `See ${layout.agentLogFile} and ${layout.agentOutFile}.`,
  );
}

export type StopOutcome = 'stopped' | 'killed' | 'not-running';

/** Asks the agent to shut down and waits for it; kills it if it does not go. */
export async function stopAgent(
  deps: FindDeps,
  options: { timeoutMs?: number; pollMs?: number } = {},
): Promise<StopOutcome> {
  const { fs, processTable, layout } = deps;
  const state = await readAgentState(fs, layout.agentStateFile);
  if (!state) return 'not-running';
  if (!processTable.isAlive(state.pid)) {
    await removeAgentState(fs, layout.agentStateFile);
    return 'not-running';
  }

  await new AgentClient(state, 2000).shutdown().catch(() => {}); // an agent that cannot answer gets killed below
  const deadline = Date.now() + (options.timeoutMs ?? 5000);
  while (processTable.isAlive(state.pid) && Date.now() < deadline) await sleep(options.pollMs ?? 50);

  const outcome: StopOutcome = processTable.isAlive(state.pid) ? 'killed' : 'stopped';
  if (outcome === 'killed') await processTable.killTree(state.pid);
  await removeAgentState(fs, layout.agentStateFile);
  return outcome;
}
