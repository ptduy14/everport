// What the relay needs from Cloudflare, as small interfaces. The real Worker passes Cloudflare's objects;
// tests pass fakes, so the logic runs in Node without Cloudflare.

export interface WorkerWebSocket {
  send(data: string | ArrayBuffer | ArrayBufferView): void;
  close(code?: number, reason?: string): void;
  /** 1 = open. Cloudflare's sockets have it; a missing value is treated as open. */
  readyState?: number;
}

export interface DurableObjectStateLike {
  getWebSockets(): WorkerWebSocket[];
  acceptWebSocket(ws: WorkerWebSocket): void;
  setWebSocketAutoResponse(pair?: unknown): void;
}

export interface DurableObjectStubLike {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespaceLike {
  idFromName(name: string): unknown;
  get(id: unknown): DurableObjectStubLike;
}

/** The bindings of the relay Worker: set per preview by `wrangler preview --var` and `--secrets-file`. */
export interface RelayEnv {
  RELAY: DurableObjectNamespaceLike;
  /** The tunnel this preview serves. */
  TUNNEL?: string;
  /** The relay secret the agent proves with HMAC. */
  SECRET?: string;
}

/** The runtime pieces that only exist inside Cloudflare. */
export interface WorkerPlatform {
  newWebSocketPair(): { client: WorkerWebSocket; server: WorkerWebSocket };
  /** Answers the agent's "ping" with "pong" without waking the Durable Object. */
  autoResponsePair(): unknown;
  /** The 101 response that hands `client` to the caller. */
  upgradeResponse(client: WorkerWebSocket): Response;
}
