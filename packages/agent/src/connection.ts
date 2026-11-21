// One tunnel: a WebSocket to the relay, kept alive and reconnected, that turns relay requests into calls
// to a local service. The wire format and the token come from @everport/relay.
import type { Logger } from '@everport/core';
import {
  CHUNK_SIZE,
  FrameType,
  connectToken,
  decodeFrame,
  decodeRequestHead,
  encodeFrame,
  encodeResponseHead,
  filterForOrigin,
  filterFromOrigin,
  splitChunks,
  type RequestHead,
} from '@everport/relay';
import { backoffDelay } from './backoff.js';

export type TunnelState = 'connecting' | 'connected' | 'replaced' | 'stopped';

export interface TunnelConfig {
  /** The slug Cloudflare gave the preview: it is the tunnel name inside the relay and in the token. */
  name: string;
  /** The tunnel's public URL (https://<name>-<worker>.<subdomain>.workers.dev). */
  url: string;
  /** Where requests go, e.g. http://127.0.0.1:3000 */
  target: string;
}

export interface TunnelStatus extends TunnelConfig {
  state: TunnelState;
  /** Epoch ms of the last state change. */
  since: number;
  lastError?: string;
  inFlight: number;
}

export interface Timings {
  pingIntervalMs: number;
  pongTimeoutMs: number;
  /** Delay before reconnecting after a missing pong. */
  fastReconnectMs: number;
  backoffBaseMs: number;
  backoffMaxMs: number;
}

export const DEFAULT_TIMINGS: Timings = {
  pingIntervalMs: 20_000,
  pongTimeoutMs: 10_000,
  fastReconnectMs: 300,
  backoffBaseMs: 1000,
  backoffMaxMs: 15_000,
};

export interface ConnectionDeps {
  logger: Logger;
  timings?: Partial<Timings>;
  random?: () => number;
  now?: () => number;
  /** Another agent took this tunnel. The connection has stopped and will not reconnect. */
  onReplaced?: () => void;
}

/** Close reason the relay sends to an agent that another agent replaced. */
const REPLACED = 'replaced';
/** Wait before sending more when this much is queued on the socket. */
const MAX_BUFFERED_BYTES = 1 << 20;

interface ActiveRequest {
  head: RequestHead;
  chunks: Uint8Array[];
  abort: AbortController;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const concat = (chunks: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
};

/** Joins the target (which may carry a path prefix) with the request path and query. */
export function buildTargetUrl(target: string, path: string): string {
  const t = new URL(target);
  return `${t.origin}${t.pathname.replace(/\/$/, '')}${path}`;
}

/** `fetch failed` hides the reason; the cause says it (ECONNREFUSED and so on). */
const describeError = (e: unknown): string => {
  const cause = e instanceof Error ? e.cause : undefined;
  if (cause instanceof Error) return cause.message;
  return e instanceof Error ? e.message : String(e);
};

export class TunnelConnection {
  private state: TunnelState = 'connecting';
  private since: number;
  private lastError: string | undefined;
  private current: WebSocket | null = null;
  private requests = new Map<number, ActiveRequest>();
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  private token = '';
  private target: string;
  private readonly timings: Timings;
  private readonly random: () => number;
  private readonly now: () => number;

  constructor(
    private readonly config: TunnelConfig,
    private readonly secret: string,
    private readonly deps: ConnectionDeps,
  ) {
    this.timings = { ...DEFAULT_TIMINGS, ...deps.timings };
    this.random = deps.random ?? Math.random;
    this.now = deps.now ?? Date.now;
    this.since = this.now();
    this.target = config.target;
  }

  /** Computes the token and opens the first connection. Resolves without waiting for the connection to open. */
  async start(): Promise<void> {
    this.token = await connectToken(this.secret, this.config.name);
    if (!this.stopped) this.connect();
  }

  setTarget(target: string): void {
    this.target = target;
  }

  status(): TunnelStatus {
    return {
      name: this.config.name,
      url: this.config.url,
      target: this.target,
      state: this.state,
      since: this.since,
      ...(this.lastError !== undefined && { lastError: this.lastError }),
      inFlight: this.requests.size,
    };
  }

  /** Closes the socket, aborts requests in flight and stops reconnecting. */
  stop(): void {
    this.stopped = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    const ws = this.current;
    this.current = null;
    this.abortAll();
    this.setState('stopped');
    if (ws) {
      try {
        ws.close(1000, 'agent stopping');
      } catch {
        // already closed
      }
    }
  }

  private setState(state: TunnelState, error?: string): void {
    if (error !== undefined) this.lastError = error;
    if (state === this.state) return;
    this.state = state;
    this.since = this.now();
  }

  private abortAll(): void {
    for (const r of this.requests.values()) r.abort.abort();
    this.requests.clear();
  }

  private wsUrl(): string {
    const u = new URL('/__connect', this.config.url);
    u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
    u.searchParams.set('token', this.token);
    return u.toString();
  }

  private scheduleReconnect(fast: boolean): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = fast
      ? this.timings.fastReconnectMs
      : backoffDelay(this.attempt++, this.random, this.timings.backoffBaseMs, this.timings.backoffMaxMs);
    this.deps.logger.info(`tunnel ${this.config.name}: reconnecting in ${delay}ms`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (!this.stopped) this.connect();
    }, delay);
  }

  private connect(): void {
    const { logger } = this.deps;
    const name = this.config.name;
    const ws = new WebSocket(this.wsUrl()); // the URL carries the token: never log it
    ws.binaryType = 'arraybuffer';
    this.current = ws;
    const requests = new Map<number, ActiveRequest>();
    this.requests = requests;
    let pingTimer: ReturnType<typeof setInterval> | undefined;
    let pongTimer: ReturnType<typeof setTimeout> | undefined;

    const teardown = () => {
      clearInterval(pingTimer);
      clearTimeout(pongTimer);
      for (const r of requests.values()) r.abort.abort();
      requests.clear();
    };

    ws.onopen = () => {
      this.attempt = 0;
      this.lastError = undefined;
      this.setState('connected');
      logger.info(`tunnel ${name}: connected`);
      pingTimer = setInterval(() => {
        if (ws.readyState !== WebSocket.OPEN) return;
        ws.send('ping');
        if (pongTimer !== undefined) return; // an earlier ping is still waiting: do not push its deadline back
        pongTimer = setTimeout(() => {
          pongTimer = undefined;
          if (ws !== this.current) return;
          logger.warn(`tunnel ${name}: no pong, dropping the socket and reconnecting`);
          this.current = null;
          teardown();
          try {
            ws.close(1000, 'pong timeout');
          } catch {
            // already closed
          }
          this.setState('connecting', 'no pong from the relay');
          this.scheduleReconnect(true);
        }, this.timings.pongTimeoutMs);
      }, this.timings.pingIntervalMs);
    };

    ws.onerror = (e) => {
      const message = (e as { message?: string }).message;
      this.lastError = message || 'connection error';
    };

    ws.onclose = (e) => {
      if (ws !== this.current) return; // an older socket: its events no longer matter
      teardown();
      this.current = null;
      logger.info(`tunnel ${name}: closed (${e.code} ${JSON.stringify(e.reason)})`);
      if (e.reason === REPLACED) {
        this.setState('replaced', 'another agent took this tunnel');
        logger.warn(`tunnel ${name}: another agent took this tunnel, stopping it here`);
        this.deps.onReplaced?.();
        return;
      }
      this.setState('connecting', this.lastError ?? `closed (${e.code})`);
      this.scheduleReconnect(false);
    };

    ws.onmessage = (ev) => {
      if (typeof ev.data === 'string') {
        if (ev.data === 'pong') {
          clearTimeout(pongTimer);
          pongTimer = undefined;
        }
        return;
      }
      this.onFrame(ws, requests, new Uint8Array(ev.data as ArrayBuffer));
    };
  }

  private send = async (ws: WebSocket, frame: Uint8Array): Promise<void> => {
    while (ws.bufferedAmount > MAX_BUFFERED_BYTES && ws.readyState === WebSocket.OPEN) await sleep(2);
    if (ws.readyState === WebSocket.OPEN) ws.send(frame);
  };

  private onFrame(ws: WebSocket, requests: Map<number, ActiveRequest>, data: Uint8Array): void {
    let frame;
    try {
      frame = decodeFrame(data);
    } catch {
      return;
    }
    const id = frame.streamId;
    switch (frame.type) {
      case FrameType.REQ_HEAD:
        try {
          requests.set(id, { head: decodeRequestHead(frame.payload), chunks: [], abort: new AbortController() });
        } catch {
          void this.send(ws, encodeFrame(FrameType.RESET, id));
        }
        break;
      case FrameType.REQ_DATA:
        requests.get(id)?.chunks.push(frame.payload.slice()); // the message buffer is reused
        break;
      case FrameType.REQ_END:
        void this.forward(ws, requests, id);
        break;
      case FrameType.RESET: {
        const request = requests.get(id);
        if (request) {
          request.abort.abort();
          requests.delete(id);
        }
        break;
      }
      default:
        break; // response-direction frames make no sense from the relay
    }
  }

  /** Calls the local service for one request and streams its answer back. */
  private async forward(ws: WebSocket, requests: Map<number, ActiveRequest>, id: number): Promise<void> {
    const request = requests.get(id);
    if (!request) return;
    const { head, chunks, abort } = request;
    let headSent = false;
    try {
      const headers = new Headers();
      for (const [k, v] of filterForOrigin(head.headers)) headers.append(k, v);
      headers.set('accept-encoding', 'identity');
      const response = await fetch(buildTargetUrl(this.target, head.path), {
        method: head.method,
        headers,
        body: head.hasBody ? concat(chunks) : undefined,
        redirect: 'manual',
        signal: abort.signal,
      });
      const responseHead = { status: response.status, headers: filterFromOrigin([...response.headers]) };
      await this.send(ws, encodeFrame(FrameType.RES_HEAD, id, encodeResponseHead(responseHead)));
      headSent = true;
      if (response.body) {
        for await (const chunk of response.body) {
          for (const part of splitChunks(chunk, CHUNK_SIZE))
            await this.send(ws, encodeFrame(FrameType.RES_DATA, id, part));
        }
      }
      await this.send(ws, encodeFrame(FrameType.RES_END, id));
    } catch (e) {
      if (abort.signal.aborted) return;
      if (!headSent) {
        const message = new TextEncoder().encode(`local server error: ${describeError(e)}`);
        const errorHead = encodeResponseHead({ status: 502, headers: [['content-type', 'text/plain; charset=utf-8']] });
        await this.send(ws, encodeFrame(FrameType.RES_HEAD, id, errorHead));
        await this.send(ws, encodeFrame(FrameType.RES_DATA, id, message));
        await this.send(ws, encodeFrame(FrameType.RES_END, id));
      } else {
        await this.send(ws, encodeFrame(FrameType.RESET, id));
      }
    } finally {
      requests.delete(id);
    }
  }
}
