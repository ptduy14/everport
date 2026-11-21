// The relay's request multiplexer: one instance per tunnel. It knows nothing about Cloudflare or Node.
// The Durable Object and the fake relay both wrap it, so they behave the same by construction.
import {
  decodeFrame,
  decodeResponseHead,
  encodeFrame,
  encodeRequestHead,
  FrameType,
  MAX_STREAM_ID,
  splitChunks,
  type HeaderList,
  type ResponseHead,
} from './frame.js';
import { filterForAgent } from './headers.js';

export interface AgentSocket {
  send(data: Uint8Array): void;
  close(code: number, reason: string): void;
}

export interface PublicRequest {
  method: string;
  /** Path including the query string. */
  path: string;
  headers: HeaderList;
  /** null when the request has no body. */
  body: ReadableStream<Uint8Array> | null;
}

export interface PublicResponse {
  status: number;
  headers: HeaderList;
  body: ReadableStream<Uint8Array> | Uint8Array | null;
}

/** Close reason sent to an agent that another agent has replaced. The old agent must exit, not reconnect. */
export const REPLACED = 'replaced';

export const DEFAULT_HEAD_TIMEOUT_MS = 30_000;

const NO_BODY_STATUS = new Set([204, 205, 304]);
const encoder = new TextEncoder();

/** 1005 (no status) and 1006 (abnormal) are not valid to send: closing with them throws. */
export const safeCloseCode = (code?: number): number => (!code || code === 1005 || code === 1006 ? 1000 : code);

const text = (status: number, message: string): PublicResponse => ({
  status,
  headers: [['content-type', 'text/plain; charset=utf-8']],
  body: encoder.encode(`${message}\n`),
});

interface HeadResult {
  head: ResponseHead;
  /** Set when the relay made the head up (agent gone, reset, bad frame): the client gets a plain 502. */
  error?: string;
}

interface Stream {
  writer: WritableStreamDefaultWriter<Uint8Array>;
  /** Writes to the response body happen one after another. */
  queue: Promise<unknown>;
  gotHead: boolean;
  resolveHead: (result: HeadResult | null) => void;
}

export interface RelayCoreOptions {
  headTimeoutMs?: number;
}

export class RelayCore {
  private readonly streams = new Map<number, Stream>();
  private nextId = 1;
  private readonly headTimeoutMs: number;

  /** `getAgent` is asked each time, so it survives a Durable Object waking up with an empty memory. */
  constructor(
    private readonly getAgent: () => AgentSocket | null,
    options: RelayCoreOptions = {},
  ) {
    this.headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
  }

  async handle(req: PublicRequest): Promise<PublicResponse> {
    const agent = this.getAgent();
    if (!agent) return text(503, 'tunnel offline');

    const id = this.allocateId();
    const transform = new TransformStream<Uint8Array, Uint8Array>();
    let resolveHead!: (result: HeadResult | null) => void;
    const headPromise = new Promise<HeadResult | null>((resolve) => (resolveHead = resolve));
    const stream: Stream = {
      writer: transform.writable.getWriter(),
      queue: Promise.resolve(),
      gotHead: false,
      resolveHead,
    };
    this.streams.set(id, stream);

    const head = {
      method: req.method,
      path: req.path,
      headers: filterForAgent(req.headers),
      hasBody: req.body !== null,
    };
    try {
      agent.send(encodeFrame(FrameType.REQ_HEAD, id, encodeRequestHead(head)));
    } catch {
      this.streams.delete(id);
      stream.writer.abort(new Error('agent socket is closed')).catch(() => {});
      return text(503, 'tunnel offline');
    }
    void this.pumpRequestBody(id, agent, req.body);

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), this.headTimeoutMs);
    });
    const result = await Promise.race([headPromise, timeout]);
    clearTimeout(timer);

    if (!result) {
      this.cancel(id);
      return text(504, 'local server did not answer in time');
    }
    if (result.error !== undefined) {
      this.discard(id, stream);
      return text(502, result.error);
    }
    if (NO_BODY_STATUS.has(result.head.status)) {
      this.discard(id, stream);
      return { status: result.head.status, headers: result.head.headers, body: null };
    }
    return { status: result.head.status, headers: result.head.headers, body: transform.readable };
  }

  /** Feeds one WebSocket message from the agent into the matching request. Never throws. */
  onAgentMessage(data: ArrayBuffer | Uint8Array | string): void {
    if (typeof data === 'string') return; // keep-alive text, answered by the runtime
    let frame;
    try {
      frame = decodeFrame(data);
    } catch {
      return;
    }
    const id = frame.streamId;
    const stream = this.streams.get(id);
    if (!stream) return;

    switch (frame.type) {
      case FrameType.RES_HEAD: {
        let head: ResponseHead;
        try {
          head = decodeResponseHead(frame.payload);
        } catch {
          this.fail(id, 'the local agent sent an invalid response');
          return;
        }
        stream.gotHead = true;
        stream.resolveHead({ head });
        break;
      }
      case FrameType.RES_DATA: {
        const chunk = frame.payload.slice(); // the message buffer is reused
        stream.queue = stream.queue.then(() => stream.writer.write(chunk)).catch(() => this.cancel(id));
        break;
      }
      case FrameType.RES_END:
        stream.queue = stream.queue
          .then(() => stream.writer.close())
          .catch(() => {})
          .finally(() => this.streams.delete(id));
        break;
      case FrameType.RESET:
        this.streams.delete(id);
        if (!stream.gotHead)
          stream.resolveHead({ head: { status: 502, headers: [] }, error: 'the local agent reset the request' });
        stream.queue = stream.queue.then(() => stream.writer.abort(new Error('reset by agent'))).catch(() => {});
        break;
      default:
        break; // request-direction frames make no sense from the agent
    }
  }

  /** The agent is gone: every request still waiting fails. Call it only when no agent socket is left. */
  dropAllStreams(reason: string): void {
    for (const [id, stream] of this.streams) {
      this.streams.delete(id);
      if (!stream.gotHead) stream.resolveHead({ head: { status: 502, headers: [] }, error: reason });
      stream.writer.abort(new Error(reason)).catch(() => {});
    }
  }

  get inFlight(): number {
    return this.streams.size;
  }

  private allocateId(): number {
    for (;;) {
      const id = this.nextId;
      this.nextId = id >= MAX_STREAM_ID ? 1 : id + 1;
      if (!this.streams.has(id)) return id;
    }
  }

  private async pumpRequestBody(
    id: number,
    agent: AgentSocket,
    body: ReadableStream<Uint8Array> | null,
  ): Promise<void> {
    try {
      if (body) {
        const reader = body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!this.streams.has(id)) return;
          for (const chunk of splitChunks(value)) agent.send(encodeFrame(FrameType.REQ_DATA, id, chunk));
        }
      }
      if (this.streams.has(id)) agent.send(encodeFrame(FrameType.REQ_END, id));
    } catch {
      this.cancel(id);
    }
  }

  /** We give up on this request (timeout, client gone): tell the agent and stop the response body. */
  private cancel(id: number): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    try {
      this.getAgent()?.send(encodeFrame(FrameType.RESET, id));
    } catch {
      // the agent is already gone
    }
    stream.resolveHead(null);
    stream.writer.abort(new Error('cancelled')).catch(() => {});
  }

  /** The agent misbehaved: fail this request and stop the agent's side of it. */
  private fail(id: number, message: string): void {
    const stream = this.streams.get(id);
    if (!stream) return;
    this.streams.delete(id);
    try {
      this.getAgent()?.send(encodeFrame(FrameType.RESET, id));
    } catch {
      // the agent is already gone
    }
    if (!stream.gotHead) stream.resolveHead({ head: { status: 502, headers: [] }, error: message });
    stream.writer.abort(new Error(message)).catch(() => {});
  }

  private discard(id: number, stream: Stream): void {
    this.streams.delete(id);
    stream.writer.abort(new Error('no body')).catch(() => {});
  }
}
