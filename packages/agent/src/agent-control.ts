import { EverportError, type AgentControl, type AgentInfo } from '@everport/core';
import { findAgent, startAgent, stopAgent, type LauncherDeps } from './launcher.js';

/** The AgentControl the facade uses with the real background process: starts it, finds it, talks to its control API. */
export class ProcessAgentControl implements AgentControl {
  constructor(private readonly deps: LauncherDeps) {}

  async status(): Promise<AgentInfo | null> {
    const client = await findAgent(this.deps);
    if (!client) return null;
    const report = await client.status();
    return {
      pid: report.pid,
      tunnels: report.tunnels.map((t) => ({
        name: t.name,
        state: t.state,
        ...(t.lastError !== undefined && { lastError: t.lastError }),
      })),
    };
  }

  async ensureRunning(): Promise<void> {
    await startAgent(this.deps);
  }

  async addTunnel(tunnel: { name: string; url: string; target: string }): Promise<void> {
    const client = await findAgent(this.deps);
    if (!client) throw new EverportError('AGENT_NOT_RUNNING', 'The agent is not running', 'Run "everport up".');
    await client.addTunnel(tunnel);
  }

  async removeTunnel(name: string): Promise<boolean> {
    const client = await findAgent(this.deps);
    return client ? client.removeTunnel(name) : false;
  }

  stop(): Promise<'stopped' | 'killed' | 'not-running'> {
    return stopAgent(this.deps);
  }
}
