import { EverportError } from '../errors.js';
import type { AgentControl, AgentInfo, AgentTunnelInfo } from '../ports.js';

/** An in-memory agent for testing the facade. Tunnels it is given connect at once unless told otherwise. */
export class FakeAgentControl implements AgentControl {
  running = false;
  /** Starting fails with this error, as when the agent cannot read its secret. */
  startFails: EverportError | undefined;
  /** State a tunnel gets when added, by name. Default: connected. */
  stateOnAdd: Record<string, AgentTunnelInfo> = {};
  tunnels = new Map<string, AgentTunnelInfo & { url: string; target: string }>();
  stopOutcome: 'stopped' | 'killed' | 'not-running' = 'stopped';
  calls: string[] = [];

  async status(): Promise<AgentInfo | null> {
    if (!this.running) return null;
    return {
      pid: 4242,
      tunnels: [...this.tunnels.values()].map(({ name, state, lastError }) => ({
        name,
        state,
        ...(lastError && { lastError }),
      })),
    };
  }

  async ensureRunning(): Promise<void> {
    this.calls.push('ensureRunning');
    if (this.startFails) throw this.startFails;
    this.running = true;
  }

  async addTunnel(tunnel: { name: string; url: string; target: string }): Promise<void> {
    this.calls.push(`addTunnel ${tunnel.name}`);
    if (!this.running) throw new EverportError('AGENT_NOT_RUNNING', 'no agent');
    const preset = this.stateOnAdd[tunnel.name] ?? { name: tunnel.name, state: 'connected' as const };
    this.tunnels.set(tunnel.name, { ...preset, url: tunnel.url, target: tunnel.target });
  }

  async removeTunnel(name: string): Promise<boolean> {
    this.calls.push(`removeTunnel ${name}`);
    return this.running && this.tunnels.delete(name);
  }

  async stop(): Promise<'stopped' | 'killed' | 'not-running'> {
    this.calls.push('stop');
    const was = this.running;
    this.running = false;
    this.tunnels.clear();
    return was ? this.stopOutcome : 'not-running';
  }
}
