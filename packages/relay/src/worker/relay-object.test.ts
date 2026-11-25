import { describe, expect, it } from 'vitest';
import {
  FrameType,
  decodeFrame,
  decodeRequestHead,
  encodeFrame,
  encodeResponseHead,
  type Frame,
  type HeaderList,
} from '../frame.js';
import type { DurableObjectStateLike, WorkerPlatform, WorkerWebSocket } from './platform.js';
import { RelayObject } from './relay-object.js';

const text = (s: string) => new TextEncoder().encode(s);
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const asBuffer = (u: Uint8Array): ArrayBuffer =>
  u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;

class FakeWs implements WorkerWebSocket {
  sent: Frame[] = [];
  strings: string[] = [];
  closes: { code?: number; reason?: string }[] = [];
  readyState = 1;
  failClose = false;

  send(data: string | ArrayBuffer | ArrayBufferView): void {
    if (typeof data === 'string') {
      this.strings.push(data);
      return;
    }
    const bytes =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(decodeFrame(bytes.slice()));
  }

  close(code?: number, reason?: string): void {
    if (this.failClose) throw new Error('already closed');
    this.closes.push({ code, reason });
    this.readyState = 3;
  }

  types(): number[] {
    return this.sent.map((f) => f.type);
  }
}

class FakeState implements DurableObjectStateLike {
  sockets: FakeWs[] = [];
  autoResponse: unknown;
  getWebSockets(): WorkerWebSocket[] {
    return [...this.sockets];
  }
  acceptWebSocket(ws: WorkerWebSocket): void {
    this.sockets.push(ws as FakeWs);
  }
  setWebSocketAutoResponse(pair?: unknown): void {
    this.autoResponse = pair;
  }
}

function setup() {
  const state = new FakeState();
  const pairs: { client: FakeWs; server: FakeWs }[] = [];
  const platform: WorkerPlatform = {
    newWebSocketPair: () => {
      const pair = { client: new FakeWs(), server: new FakeWs() };
      pairs.push(pair);
      return pair;
    },
    autoResponsePair: () => 'ping-pong',
    upgradeResponse: (client) => ({ status: 101, client }) as unknown as Response,
  };
  const object = new RelayObject(state, platform);
  const agent = new FakeWs();
  state.sockets.push(agent);
  const reply = (
    ws: FakeWs,
    id: number,
    status: number,
    body = '',
    headers: HeaderList = [],
    target: RelayObject = object,
  ) => {
    target.webSocketMessage(ws, asBuffer(encodeFrame(FrameType.RES_HEAD, id, encodeResponseHead({ status, headers }))));
    if (body) target.webSocketMessage(ws, asBuffer(encodeFrame(FrameType.RES_DATA, id, text(body))));
    target.webSocketMessage(ws, asBuffer(encodeFrame(FrameType.RES_END, id)));
  };
  return { state, pairs, platform, object, agent, reply };
}

const upgrade = () => new Request('https://x.workers.dev/__connect', { headers: { upgrade: 'websocket' } });
const getRequest = (path = '/hello?x=1') =>
  new Request(`https://x.workers.dev${path}`, { headers: { accept: 'text/html', 'accept-encoding': 'gzip' } });

describe('RelayObject: waking up and accepting an agent', () => {
  it('registers the ping/pong auto-response, which answers without waking the object', () => {
    expect(setup().state.autoResponse).toBe('ping-pong');
  });

  it('accepts the server end of a new pair and hands the client end to the caller', async () => {
    const { object, state, pairs } = setup();
    const res = (await object.fetch(upgrade())) as unknown as { status: number; client: FakeWs };
    expect(res.status).toBe(101);
    expect(res.client).toBe(pairs[0]!.client);
    expect(state.sockets).toContain(pairs[0]!.server);
  });

  it('tells the old agent it was replaced, before the new one is accepted', async () => {
    const { object, agent } = setup();
    await object.fetch(upgrade());
    expect(agent.closes).toEqual([{ code: 1000, reason: 'replaced' }]);
  });

  it('fails the requests of the old agent with a 502 when a new agent takes over', async () => {
    const { object } = setup();
    const pending = object.fetch(getRequest());
    await tick();
    await object.fetch(upgrade());
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('agent replaced');
  });

  it('never takes an upgrade on another path as the agent: the connected agent stays', async () => {
    const { object, agent, state } = setup();
    const res = await object.fetch(new Request('https://x.workers.dev/hmr', { headers: { upgrade: 'websocket' } }));
    expect(res.status).toBe(501);
    expect(agent.closes).toEqual([]);
    expect(state.sockets).toEqual([agent]);
  });

  it('does not stop on an old socket that refuses to close', async () => {
    const { object, agent } = setup();
    agent.failClose = true;
    await expect(object.fetch(upgrade())).resolves.toBeDefined();
  });
});

describe('RelayObject: public requests', () => {
  it('answers 503 when no agent is connected', async () => {
    const { object, state } = setup();
    state.sockets.length = 0;
    const res = await object.fetch(getRequest());
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('tunnel offline\n');
  });

  it('forwards the request to the agent and returns its answer, repeated headers included', async () => {
    const { object, agent, reply } = setup();
    const pending = object.fetch(getRequest());
    await tick();
    expect(agent.types()).toEqual([FrameType.REQ_HEAD, FrameType.REQ_END]);
    expect(decodeRequestHead(agent.sent[0]!.payload)).toEqual({
      method: 'GET',
      path: '/hello?x=1',
      headers: [['accept', 'text/html']],
      hasBody: false,
    });
    reply(agent, agent.sent[0]!.streamId, 200, 'hello', [
      ['content-type', 'text/plain'],
      ['set-cookie', 'a=1'],
      ['set-cookie', 'b=2'],
    ]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hello');
    expect(res.headers.getSetCookie()).toEqual(['a=1', 'b=2']);
  });

  it('sends a request body to the agent in frames', async () => {
    const { object, agent, reply } = setup();
    const body = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const pending = object.fetch(new Request('https://x.workers.dev/upload', { method: 'POST', body }));
    await tick();
    await tick();
    expect(decodeRequestHead(agent.sent[0]!.payload).hasBody).toBe(true);
    const received = agent.sent.filter((f) => f.type === FrameType.REQ_DATA).map((f) => f.payload);
    expect(received.map((p) => p.length)).toEqual([65536, 65536, 150_000 - 131_072]);
    reply(agent, agent.sent[0]!.streamId, 200, 'ok');
    expect((await pending).status).toBe(200);
  });

  it('returns no body for a 204', async () => {
    const { object, agent, reply } = setup();
    const pending = object.fetch(getRequest());
    await tick();
    reply(agent, agent.sent[0]!.streamId, 204);
    const res = await pending;
    expect(res.status).toBe(204);
    expect(res.body).toBeNull();
  });

  it('sends requests to the newest open agent socket and ignores a closing one', async () => {
    const { object, state, agent, reply } = setup();
    const closing = new FakeWs();
    closing.readyState = 2;
    const newest = new FakeWs();
    state.sockets.push(closing, newest);
    const pending = object.fetch(getRequest());
    await tick();
    expect(agent.sent).toHaveLength(0);
    expect(closing.sent).toHaveLength(0);
    expect(newest.types()).toEqual([FrameType.REQ_HEAD, FrameType.REQ_END]);
    reply(newest, newest.sent[0]!.streamId, 200, 'from the newest');
    expect(await (await pending).text()).toBe('from the newest');
  });

  it('keeps serving after the object woke up with an empty memory, since the sockets survive hibernation', async () => {
    const { state, platform, agent, reply } = setup();
    const reborn = new RelayObject(state, platform); // a new instance over the same live sockets
    const pending = reborn.fetch(getRequest('/after-sleep'));
    await tick();
    expect(agent.sent[0]!.type).toBe(FrameType.REQ_HEAD);
    reply(agent, agent.sent[0]!.streamId, 200, 'awake', [], reborn); // the runtime hands messages to the live instance
    expect(await (await pending).text()).toBe('awake');
  });
});

describe('RelayObject: the agent goes away', () => {
  it('fails waiting requests with a 502 when the last agent socket closes, and closes with a valid code', async () => {
    const { object, agent } = setup();
    const pending = object.fetch(getRequest());
    await tick();
    object.webSocketClose(agent, 1005, '');
    const res = await pending;
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('agent disconnected');
    expect(agent.closes).toEqual([{ code: 1000, reason: '' }]);
  });

  it('leaves requests alone when an old, replaced socket closes while a new one is connected', async () => {
    const { object, state, agent, reply } = setup();
    const newer = new FakeWs();
    state.sockets.push(newer);
    const pending = object.fetch(getRequest());
    await tick();
    object.webSocketClose(agent, 1000, 'replaced');
    reply(newer, newer.sent[0]!.streamId, 200, 'still alive');
    expect(await (await pending).text()).toBe('still alive');
  });

  it('does not throw when closing the socket fails, nor on keep-alive text', () => {
    const { object, agent } = setup();
    agent.failClose = true;
    expect(() => object.webSocketClose(agent, 1006, '')).not.toThrow();
    expect(() => object.webSocketMessage(agent, 'ping')).not.toThrow();
  });

  it('closes a socket that reports an error with code 1011, even if it is already closed', () => {
    const { object, agent } = setup();
    object.webSocketError(agent);
    expect(agent.closes).toEqual([{ code: 1011, reason: 'error' }]);
    agent.failClose = true;
    expect(() => object.webSocketError(agent)).not.toThrow();
  });
});
