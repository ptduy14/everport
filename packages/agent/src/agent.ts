import { EverportError, type Logger } from '@everport/core';
import {
  TunnelConnection,
  type ConnectionDeps,
  type Timings,
  type TunnelConfig,
  type TunnelStatus,
} from './connection.js';

export interface RelayAgentOptions {
  /** The relay secret (the contents of the relay-secret file). Never leaves this process. */
  secret: string;
  logger: Logger;
  timings?: Partial<Timings>;
  random?: () => number;
  now?: () => number;
  /** Every tunnel was taken over by another agent: there is nothing left to serve, the process may exit. */
  onIdle?: () => void;
}

export interface AgentStatus {
  startedAt: number;
  tunnels: TunnelStatus[];
}

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** Holds one connection per tunnel. Adding, removing and stopping are safe while it runs. */
export class RelayAgent {
  private readonly tunnels = new Map<string, { config: TunnelConfig; connection: TunnelConnection }>();
  private readonly startedAt: number;

  constructor(private readonly options: RelayAgentOptions) {
    this.startedAt = (options.now ?? Date.now)();
  }

  /**
   * Starts serving a tunnel. An existing tunnel of the same name keeps its connection when only the target
   * changed, and is reconnected when the URL changed. Resolves once the connection is started, not once it is open.
   */
  async addTunnel(config: TunnelConfig): Promise<void> {
    if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/.test(config.name)) {
      throw new EverportError('INVALID_NAME', `"${config.name}" is not a valid tunnel name`);
    }
    if (!isHttpUrl(config.url)) throw new EverportError('INVALID_TARGET', `"${config.url}" is not an http(s) URL`);
    if (!isHttpUrl(config.target))
      throw new EverportError('INVALID_TARGET', `"${config.target}" is not an http(s) URL`);

    const existing = this.tunnels.get(config.name);
    if (existing && existing.config.url === config.url && existing.connection.status().state !== 'replaced') {
      existing.config = config;
      existing.connection.setTarget(config.target);
      return;
    }
    existing?.connection.stop();

    const deps: ConnectionDeps = {
      logger: this.options.logger,
      ...(this.options.timings && { timings: this.options.timings }),
      ...(this.options.random && { random: this.options.random }),
      ...(this.options.now && { now: this.options.now }),
      onReplaced: () => this.onReplaced(),
    };
    const connection = new TunnelConnection(config, this.options.secret, deps);
    this.tunnels.set(config.name, { config, connection });
    await connection.start();
  }

  /** Stops serving a tunnel. Returns false when there was no such tunnel. */
  removeTunnel(name: string): boolean {
    const entry = this.tunnels.get(name);
    if (!entry) return false;
    entry.connection.stop();
    this.tunnels.delete(name);
    return true;
  }

  status(): AgentStatus {
    return { startedAt: this.startedAt, tunnels: [...this.tunnels.values()].map((t) => t.connection.status()) };
  }

  /** Stops every tunnel: sockets close and requests in flight are aborted. */
  stop(): void {
    for (const { connection } of this.tunnels.values()) connection.stop();
    this.tunnels.clear();
  }

  private onReplaced(): void {
    const stillServing = [...this.tunnels.values()].some((t) => {
      const { state } = t.connection.status();
      return state === 'connecting' || state === 'connected';
    });
    if (!stillServing) this.options.onIdle?.();
  }
}
