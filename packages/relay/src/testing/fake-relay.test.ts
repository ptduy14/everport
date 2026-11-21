import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';
import {
  FrameType,
  decodeFrame,
  decodeRequestHead,
  encodeFrame,
  encodeResponseHead,
  type Frame,
  type HeaderList,
  type RequestHead,
} from '../frame.js';
import { connectToken } from '../token.js';
import { FakeRelay } from './fake-relay.js';

const SECRET = 'c0ffee'.repeat(10);
const TUNNEL = 'fe';
const text = (s: string) => new TextEncoder().encode(s);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(condition: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for a condition');
    await sleep(10);
  }
}

interface AgentRequest {
  id: number;
  head: RequestHead;
  body: Uint8Array;
}

interface TestAgent {
  ws: WebSocket;
  frames: Frame[];
  messages: string[];
  closed: { code: number; reason: string } | null;
  send: (frame: Uint8Array) => void;
  reply: (id: number, status: number, body?: string, headers?: HeaderList) => void;
}

let relay: FakeRelay;
let base: string;
const agents: TestAgent[] = [];

beforeEach(async () => {
  relay = new FakeRelay({ secret: SECRET, tunnel: TUNNEL, headTimeoutMs: 1000 });
  base = await relay.start();
});

afterEach(async () => {
  for (const a of agents.splice(0)) a.ws.terminate();
  await relay.stop();
});

/** Connects an agent with a valid token. `onRequest` runs when a whole request has arrived. */
async function connectAgent(onRequest?: (req: AgentRequest, agent: TestAgent) => void): Promise<TestAgent> {
  const token = await connectToken(SECRET, TUNNEL);
  const ws = new WebSocket(`${base.replace('http', 'ws')}/__connect?token=${token}`);
  const agent: TestAgent = {
    ws,
    frames: [],
    messages: [],
    closed: null,
    send: (frame) => ws.send(frame),
    reply: (id, status, body = '', headers = []) => {
      ws.send(encodeFrame(FrameType.RES_HEAD, id, encodeResponseHead({ status, headers })));
      if (body) ws.send(encodeFrame(FrameType.RES_DATA, id, text(body)));
      ws.send(encodeFrame(FrameType.RES_END, id));
    },
  };
  const pending = new Map<number, { head: RequestHead; chunks: Uint8Array[] }>();
  ws.on('message', (data, isBinary) => {
    if (!isBinary) {
      agent.messages.push(data.toString());
      return;
    }
    const raw = decodeFrame(new Uint8Array(data as Buffer));
    const frame = { ...raw, payload: raw.payload.slice() };
    agent.frames.push(frame);
    if (frame.type === FrameType.REQ_HEAD) {
      pending.set(frame.streamId, { head: decodeRequestHead(frame.payload), chunks: [] });
    } else if (frame.type === FrameType.REQ_DATA) {
      pending.get(frame.streamId)?.chunks.push(frame.payload);
    } else if (frame.type === FrameType.REQ_END) {
      const p = pending.get(frame.streamId);
      if (!p || !onRequest) return;
      const body = new Uint8Array(p.chunks.reduce((n, c) => n + c.length, 0));
      let offset = 0;
      for (const c of p.chunks) {
        body.set(c, offset);
        offset += c.length;
      }
      onRequest({ id: frame.streamId, head: p.head, body }, agent);
    }
  });
  ws.on('close', (code, reason) => (agent.closed = { code, reason: reason.toString() }));
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  agents.push(agent);
  return agent;
}

const resetsFor = (agent: TestAgent, id: number) =>
  agent.frames.filter((f) => f.type === FrameType.RESET && f.streamId === id);

describe('FakeRelay: the entrance', () => {
  it('names itself, its code version and its tunnel on /__ep/version', async () => {
    const res = await fetch(`${base}/__ep/version`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'everport-relay', codeVersion: '1', tunnel: TUNNEL });
  });

  it('answers 426 to /__connect when the request is not a WebSocket', async () => {
    expect((await fetch(`${base}/__connect`)).status).toBe(426);
  });

  it('answers 503 when no agent is connected', async () => {
    const res = await fetch(`${base}/anything`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('tunnel offline\n');
  });

  it.each([
    ['a wrong token', '?token=deadbeef'],
    ['no token', ''],
  ])('answers 403 to the WebSocket handshake with %s', async (_name, query) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}/__connect${query}`);
    const status = await new Promise<number>((resolve) => {
      ws.on('unexpected-response', (req, res) => {
        resolve(res.statusCode ?? 0);
        req.destroy();
      });
      ws.on('error', () => {});
    });
    expect(status).toBe(403);
    expect(relay.connectedAgents).toBe(0);
  });
});

describe('FakeRelay: requests through an agent', () => {
  it('carries a request to the agent and its answer back to the caller', async () => {
    let seen: AgentRequest | undefined;
    await connectAgent((req, agent) => {
      seen = req;
      agent.reply(req.id, 200, 'hello', [['x-from', 'agent']]);
    });
    const res = await fetch(`${base}/hello?x=1`, { headers: { 'x-test': 'yes' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-from')).toBe('agent');
    expect(await res.text()).toBe('hello');
    expect(seen?.head.method).toBe('GET');
    expect(seen?.head.path).toBe('/hello?x=1');
    expect(seen?.head.hasBody).toBe(false);
    expect(seen?.head.headers.some(([n, v]) => n.toLowerCase() === 'x-test' && v === 'yes')).toBe(true);
  });

  it('delivers a 150 KB upload to the agent intact, in frames of at most 64 KiB', async () => {
    const upload = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    let received: Uint8Array | undefined;
    const agent = await connectAgent((req, a) => {
      received = req.body;
      a.reply(req.id, 200, 'ok');
    });
    const res = await fetch(`${base}/upload`, { method: 'POST', body: upload });
    expect(res.status).toBe(200);
    expect(received).toEqual(upload);
    const sizes = agent.frames.filter((f) => f.type === FrameType.REQ_DATA).map((f) => f.payload.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(64 * 1024);
  });

  it('streams a response chunk by chunk instead of waiting for the end', async () => {
    await connectAgent(async (req, agent) => {
      agent.send(encodeFrame(FrameType.RES_HEAD, req.id, encodeResponseHead({ status: 200, headers: [] })));
      for (const part of ['tick 1', 'tick 2', 'tick 3']) {
        agent.send(encodeFrame(FrameType.RES_DATA, req.id, text(part)));
        await sleep(150);
      }
      agent.send(encodeFrame(FrameType.RES_END, req.id));
    });
    const started = Date.now();
    const res = await fetch(`${base}/sse`);
    const reader = res.body!.getReader();
    const first = await reader.read();
    const firstAt = Date.now() - started;
    expect(new TextDecoder().decode(first.value)).toContain('tick 1');
    let rest = '';
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      rest += new TextDecoder().decode(value);
    }
    expect(rest).toContain('tick 3');
    expect(Date.now() - started).toBeGreaterThan(firstAt + 200);
  });

  it('returns no body for 204', async () => {
    await connectAgent((req, agent) => agent.reply(req.id, 204));
    const res = await fetch(`${base}/empty`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('answers 504 when the agent never answers, and resets the request', async () => {
    const quick = new FakeRelay({ secret: SECRET, tunnel: TUNNEL, headTimeoutMs: 100 });
    await relay.stop();
    relay = quick;
    base = await quick.start();
    const agent = await connectAgent();
    const res = await fetch(`${base}/slow`);
    expect(res.status).toBe(504);
    const id = agent.frames.find((f) => f.type === FrameType.REQ_HEAD)!.streamId;
    await waitFor(() => resetsFor(agent, id).length === 1);
  });

  it('tells the agent to stop when the caller gives up midway', async () => {
    let streamId = 0;
    let stop = false;
    const agent = await connectAgent((req, a) => {
      streamId = req.id;
      a.send(encodeFrame(FrameType.RES_HEAD, req.id, encodeResponseHead({ status: 200, headers: [] })));
      void (async () => {
        while (!stop && a.ws.readyState === WebSocket.OPEN) {
          a.send(encodeFrame(FrameType.RES_DATA, req.id, text('data data data')));
          await sleep(20);
        }
      })();
    });
    const controller = new AbortController();
    const res = await fetch(`${base}/endless`, { signal: controller.signal });
    await res.body!.getReader().read();
    controller.abort();
    await waitFor(() => resetsFor(agent, streamId).length > 0);
    stop = true;
  });

  it('answers 502 when the agent disconnects while a request waits', async () => {
    const agent = await connectAgent();
    const pending = fetch(`${base}/waiting`);
    await waitFor(() => agent.frames.some((f) => f.type === FrameType.REQ_END));
    agent.ws.terminate();
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('agent disconnected');
  });
});

describe('FakeRelay: one agent per tunnel', () => {
  it('closes the old agent with "replaced" and sends new requests to the new one', async () => {
    const first = await connectAgent((req, a) => a.reply(req.id, 200, 'first'));
    const second = await connectAgent((req, a) => a.reply(req.id, 200, 'second'));
    await waitFor(() => first.closed !== null);
    expect(first.closed).toEqual({ code: 1000, reason: 'replaced' });
    expect(second.closed).toBeNull();
    expect(await (await fetch(`${base}/who`)).text()).toBe('second');
    expect(relay.connectedAgents).toBe(1);
  });

  it('keeps the new agent working after the old one has finished closing', async () => {
    const first = await connectAgent();
    await connectAgent((req, a) => a.reply(req.id, 200, 'still here'));
    await waitFor(() => first.closed !== null);
    await sleep(50);
    expect(await (await fetch(`${base}/after`)).text()).toBe('still here');
  });
});

describe('FakeRelay: keep-alive', () => {
  it('answers the agent\'s "ping" with "pong"', async () => {
    const agent = await connectAgent();
    agent.ws.send('ping');
    await waitFor(() => agent.messages.includes('pong'));
  });

  it('stays silent when auto-pong is off, to test an agent that waits for pong', async () => {
    await relay.stop();
    relay = new FakeRelay({ secret: SECRET, tunnel: TUNNEL, autoPong: false });
    base = await relay.start();
    const agent = await connectAgent();
    agent.ws.send('ping');
    await sleep(150);
    expect(agent.messages).toEqual([]);
  });
});
