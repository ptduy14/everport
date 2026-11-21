import type { FileSystem } from '@everport/core';

/** What a running agent publishes in agent.json so that CLI and VS Code can find and control it. */
export interface AgentState {
  pid: number;
  /** Port of the control API on 127.0.0.1. */
  port: number;
  /** Random per run: every control call must carry it. */
  token: string;
  startedAt: number;
}

export function parseAgentState(text: string): AgentState | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const { pid, port, token, startedAt } = raw as Record<string, unknown>;
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid < 1) return null;
  if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (typeof token !== 'string' || token === '') return null;
  if (typeof startedAt !== 'number') return null;
  return { pid, port, token, startedAt };
}

/** The published state, or null when there is none or it is unreadable (a half-written file counts as none). */
export async function readAgentState(fs: FileSystem, file: string): Promise<AgentState | null> {
  const text = await fs.readText(file);
  return text === null ? null : parseAgentState(text);
}

/** Written privately (it holds the token) and atomically, so a reader never sees half a file. */
export async function writeAgentState(fs: FileSystem, file: string, state: AgentState): Promise<void> {
  const tmp = `${file}.${state.pid}.tmp`;
  await fs.writeTextPrivate(tmp, `${JSON.stringify(state)}\n`);
  await fs.rename(tmp, file);
}

/** Removes agent.json. With `onlyIfPid`, leaves it alone when it now belongs to a different agent. */
export async function removeAgentState(fs: FileSystem, file: string, onlyIfPid?: number): Promise<void> {
  if (onlyIfPid !== undefined) {
    const state = await readAgentState(fs, file);
    if (state && state.pid !== onlyIfPid) return;
  }
  await fs.remove(file);
}
