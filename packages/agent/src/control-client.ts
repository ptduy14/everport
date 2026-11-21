import { EverportError, type EverportErrorCode } from '@everport/core';
import type { AgentStatus } from './agent.js';
import type { TunnelConfig } from './connection.js';
import { TOKEN_HEADER } from './control-server.js';

export interface AgentConnection {
  port: number;
  token: string;
}

export interface AgentStatusReport extends AgentStatus {
  pid: number;
}

/** Error codes the API can send that the client passes on as they are. */
const PASSED_ON = new Set<string>(['INVALID_NAME', 'INVALID_TARGET', 'TUNNEL_NOT_FOUND']);

/** Talks to a running agent's control API. Network and token problems come out as AGENT_NOT_RUNNING. */
export class AgentClient {
  constructor(
    readonly connection: AgentConnection,
    private readonly timeoutMs = 5000,
  ) {}

  async status(): Promise<AgentStatusReport> {
    const { json } = await this.request('GET', '/status');
    return json as AgentStatusReport;
  }

  async addTunnel(config: TunnelConfig): Promise<void> {
    await this.request('POST', '/tunnels', config);
  }

  /** Returns false when the agent had no such tunnel. */
  async removeTunnel(name: string): Promise<boolean> {
    const { status } = await this.request('DELETE', `/tunnels/${encodeURIComponent(name)}`, undefined, [404]);
    return status !== 404;
  }

  async shutdown(): Promise<void> {
    await this.request('POST', '/shutdown');
  }

  private async request(
    method: string,
    path: string,
    body?: unknown,
    acceptedStatuses: number[] = [],
  ): Promise<{ status: number; json: unknown }> {
    let response: Response;
    try {
      response = await fetch(`http://127.0.0.1:${this.connection.port}${path}`, {
        method,
        headers: { [TOKEN_HEADER]: this.connection.token, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      throw new EverportError(
        'AGENT_NOT_RUNNING',
        `Cannot reach the agent: ${e instanceof Error ? e.message : String(e)}`,
        'Run "everport up" to start it.',
      );
    }
    const json: unknown = await response.json().catch(() => null);
    if (response.ok || acceptedStatuses.includes(response.status)) return { status: response.status, json };
    if (response.status === 401) {
      throw new EverportError(
        'AGENT_NOT_RUNNING',
        'The agent rejected the token',
        'agent.json may be stale: run "everport up".',
      );
    }
    const error = (json as { error?: { code?: string; message?: string; hint?: string } } | null)?.error;
    const code = (error?.code && PASSED_ON.has(error.code) ? error.code : 'INTERNAL') as EverportErrorCode;
    throw new EverportError(code, error?.message ?? `The agent answered ${response.status}`, error?.hint);
  }
}
