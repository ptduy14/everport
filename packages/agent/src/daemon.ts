// What runs inside the agent process: the RelayAgent, its control API, and the agent.json that publishes them.
import { randomBytes } from 'node:crypto';
import { EverportError, type FileSystem, type Layout, type Logger, type ProcessTable } from '@everport/core';
import { RelayAgent } from './agent.js';
import type { Timings } from './connection.js';
import { AgentControlServer } from './control-server.js';
import { readAgentState, removeAgentState, writeAgentState } from './state.js';

export interface DaemonOptions {
  layout: Layout;
  fs: FileSystem;
  logger: Logger;
  pid: number;
  /** Used to refuse to start while another agent is alive. Without it the check is skipped. */
  processTable?: ProcessTable;
  timings?: Partial<Timings>;
  /** Called once everything is stopped. The real process exits here. */
  onExit?: (code: number) => void;
}

export interface Daemon {
  agent: RelayAgent;
  port: number;
  token: string;
  /** Stops tunnels and the control API and removes agent.json. Safe to call more than once. */
  shutdown(code?: number): Promise<void>;
}

export async function runDaemon(options: DaemonOptions): Promise<Daemon> {
  const { layout, fs, logger, pid } = options;

  const secret = (await fs.readText(layout.relaySecretFile))?.trim();
  if (!secret) {
    throw new EverportError(
      'CONFIG_INVALID',
      `The relay secret is missing (${layout.relaySecretFile})`,
      'Run "everport add" once: it creates the relay and its secret.',
    );
  }

  const existing = await readAgentState(fs, layout.agentStateFile);
  if (existing && existing.pid !== pid && options.processTable?.isAlive(existing.pid)) {
    throw new EverportError(
      'LOCKED',
      `Another agent is already running (pid ${existing.pid})`,
      'Run "everport down" first.',
    );
  }

  const token = randomBytes(32).toString('hex');
  let stopping: Promise<void> | undefined;
  const shutdown = (code = 0): Promise<void> =>
    (stopping ??= (async () => {
      logger.info(`agent shutting down (exit code ${code})`);
      agent.stop();
      await control.stop();
      await removeAgentState(fs, layout.agentStateFile, pid);
      options.onExit?.(code);
    })());

  const agent = new RelayAgent({
    secret,
    logger,
    ...(options.timings && { timings: options.timings }),
    onIdle: () => {
      logger.info('every tunnel was taken over by another agent: nothing left to serve');
      void shutdown(0);
    },
  });
  const control = new AgentControlServer({ agent, token, pid, onShutdown: () => void shutdown(0) });
  const port = await control.start();
  await writeAgentState(fs, layout.agentStateFile, { pid, port, token, startedAt: Date.now() });
  logger.info(`agent started (pid ${pid}, control port ${port})`);

  return { agent, port, token, shutdown };
}
