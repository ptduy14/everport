import { decodeFrame, FrameType, type Frame } from '../frame.js';
import type { AgentSocket } from '../relay-core.js';

/** An in-memory agent socket: records every frame the relay sends and every close. */
export class FakeAgentSocket implements AgentSocket {
  sent: Frame[] = [];
  closed: { code: number; reason: string } | null = null;
  failSends = false;

  send(data: Uint8Array): void {
    if (this.failSends) throw new Error('socket closed');
    this.sent.push(decodeFrame(data.slice())); // copy: the relay may reuse the buffer
  }

  close(code: number, reason: string): void {
    this.closed = { code, reason };
  }

  types(): number[] {
    return this.sent.map((f) => f.type);
  }

  framesOf(type: number): Frame[] {
    return this.sent.filter((f) => f.type === type);
  }

  /** True once a RESET for this stream was sent. */
  wasReset(streamId: number): boolean {
    return this.sent.some((f) => f.type === FrameType.RESET && f.streamId === streamId);
  }
}

/** A ReadableStream that emits the given chunks, then ends. */
export function streamOf(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[i++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
  });
}

export async function readAll(body: ReadableStream<Uint8Array> | Uint8Array | null): Promise<Uint8Array> {
  if (body === null) return new Uint8Array(0);
  if (body instanceof Uint8Array) return body;
  const reader = body.getReader();
  const parts: Uint8Array[] = [];
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
  }
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

/** Lets pending promise callbacks and zero-delay timers run. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
