import { describe, expect, it } from 'vitest';
import { CHUNK_SIZE, FrameType, decodeRequestHead, encodeFrame, encodeResponseHead, type HeaderList } from './frame.js';
import { REPLACED, RelayCore, safeCloseCode, type PublicRequest } from './relay-core.js';
import { FakeAgentSocket, readAll, streamOf, tick } from './testing/fake-agent-socket.js';

const text = (s: string) => new TextEncoder().encode(s);
const decode = (b: Uint8Array) => new TextDecoder().decode(b);

const request = (over: Partial<PublicRequest> = {}): PublicRequest => ({
  method: 'GET',
  path: '/hello',
  headers: [['accept', 'text/html']],
  body: null,
  ...over,
});

function setup(options: { headTimeoutMs?: number } = {}) {
  const agent = new FakeAgentSocket();
  let current: FakeAgentSocket | null = agent;
  const core = new RelayCore(() => current, options);
  return {
    agent,
    core,
    setAgent: (a: FakeAgentSocket | null) => (current = a),
    head: (id: number, status: number, headers: HeaderList = []) =>
      core.onAgentMessage(encodeFrame(FrameType.RES_HEAD, id, encodeResponseHead({ status, headers }))),
    data: (id: number, s: string | Uint8Array) =>
      core.onAgentMessage(encodeFrame(FrameType.RES_DATA, id, typeof s === 'string' ? text(s) : s)),
    end: (id: number) => core.onAgentMessage(encodeFrame(FrameType.RES_END, id)),
    reset: (id: number) => core.onAgentMessage(encodeFrame(FrameType.RESET, id)),
  };
}

describe('RelayCore: reaching the agent', () => {
  it('answers 503 right away when no agent is connected', async () => {
    const { core, setAgent } = setup();
    setAgent(null);
    const res = await core.handle(request());
    expect(res.status).toBe(503);
    expect(decode(await readAll(res.body))).toBe('tunnel offline\n');
  });

  it('answers 503 when sending to the agent socket throws', async () => {
    const { core, agent } = setup();
    agent.failSends = true;
    expect((await core.handle(request())).status).toBe(503);
    expect(core.inFlight).toBe(0);
  });

  it('sends REQ_HEAD then REQ_END for a request without a body, with hop headers removed', async () => {
    const { core, agent, head, end } = setup();
    const pending = core.handle(
      request({
        headers: [
          ['accept', 'text/html'],
          ['accept-encoding', 'gzip'],
          ['connection', 'keep-alive'],
        ],
      }),
    );
    await tick();
    expect(agent.types()).toEqual([FrameType.REQ_HEAD, FrameType.REQ_END]);
    const frame = agent.sent[0]!;
    expect(decodeRequestHead(frame.payload)).toEqual({
      method: 'GET',
      path: '/hello',
      headers: [['accept', 'text/html']],
      hasBody: false,
    });
    head(frame.streamId, 200);
    end(frame.streamId);
    expect((await pending).status).toBe(200);
  });

  it('cuts a request body into frames of at most 64 KiB and ends with REQ_END', async () => {
    const { core, agent, head, end } = setup();
    const body = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const pending = core.handle(request({ method: 'POST', body: streamOf([body]) }));
    await tick();
    expect(agent.types()).toEqual([
      FrameType.REQ_HEAD,
      FrameType.REQ_DATA,
      FrameType.REQ_DATA,
      FrameType.REQ_DATA,
      FrameType.REQ_END,
    ]);
    const parts = agent.framesOf(FrameType.REQ_DATA).map((f) => f.payload);
    expect(parts.map((p) => p.length)).toEqual([CHUNK_SIZE, CHUNK_SIZE, 150_000 - 2 * CHUNK_SIZE]);
    const joined = new Uint8Array(150_000);
    let offset = 0;
    for (const p of parts) {
      joined.set(p, offset);
      offset += p.length;
    }
    expect(joined).toEqual(body);
    expect(decodeRequestHead(agent.sent[0]!.payload).hasBody).toBe(true);
    const id = agent.sent[0]!.streamId;
    head(id, 200);
    end(id);
    await pending;
  });

  it('gives concurrent requests their own stream ids and routes each answer to its own request', async () => {
    const { core, agent, head, data, end } = setup();
    const a = core.handle(request({ path: '/a' }));
    const b = core.handle(request({ path: '/b' }));
    await tick();
    const [idA, idB] = agent.framesOf(FrameType.REQ_HEAD).map((f) => f.streamId) as [number, number];
    expect(idA).not.toBe(idB);
    head(idB, 200);
    data(idB, 'bee');
    end(idB);
    head(idA, 201);
    data(idA, 'ay');
    end(idA);
    const [resA, resB] = await Promise.all([a, b]);
    expect([resA.status, decode(await readAll(resA.body))]).toEqual([201, 'ay']);
    expect([resB.status, decode(await readAll(resB.body))]).toEqual([200, 'bee']);
  });
});

describe('RelayCore: the response', () => {
  it('returns the agent head and body', async () => {
    const { core, agent, head, data, end } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    head(id, 200, [['content-type', 'text/plain']]);
    data(id, 'hello ');
    data(id, 'world');
    end(id);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers).toEqual([['content-type', 'text/plain']]);
    expect(decode(await readAll(res.body))).toBe('hello world');
    await tick();
    expect(core.inFlight).toBe(0);
  });

  it('hands over body chunks as they arrive, before the response ends', async () => {
    const { core, agent, head, data, end } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    head(id, 200);
    const res = await pending;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    data(id, 'tick 1');
    expect(decode((await reader.read()).value!)).toBe('tick 1');
    data(id, 'tick 2');
    expect(decode((await reader.read()).value!)).toBe('tick 2');
    end(id);
    expect((await reader.read()).done).toBe(true);
  });

  it.each([204, 205, 304])('returns no body for status %s and forgets the stream', async (status) => {
    const { core, agent, head, data } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    head(id, status);
    const res = await pending;
    expect(res.body).toBeNull();
    data(id, 'late');
    expect(core.inFlight).toBe(0);
  });
});

describe('RelayCore: failures', () => {
  it('answers 504 and resets the stream when the head does not come in time', async () => {
    const { core, agent } = setup({ headTimeoutMs: 20 });
    const res = await core.handle(request());
    expect(res.status).toBe(504);
    expect(agent.wasReset(agent.sent[0]!.streamId)).toBe(true);
    expect(core.inFlight).toBe(0);
  });

  it('answers 502 when the agent resets before sending a head', async () => {
    const { core, agent, reset } = setup();
    const pending = core.handle(request());
    await tick();
    reset(agent.sent[0]!.streamId);
    const res = await pending;
    expect(res.status).toBe(502);
    expect(decode(await readAll(res.body))).toContain('reset');
  });

  it('answers 502 and resets the stream when the agent sends an invalid head', async () => {
    const { core, agent } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    core.onAgentMessage(encodeFrame(FrameType.RES_HEAD, id, text('not json')));
    expect((await pending).status).toBe(502);
    expect(agent.wasReset(id)).toBe(true);
  });

  it('breaks the body when the agent resets after the head', async () => {
    const { core, agent, head, data, reset } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    head(id, 200);
    const res = await pending;
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    data(id, 'part');
    expect(decode((await reader.read()).value!)).toBe('part');
    reset(id);
    await expect(reader.read()).rejects.toThrow();
  });

  it('dropAllStreams gives waiting requests a 502 and breaks bodies already started', async () => {
    const { core, agent, head, data } = setup();
    const waiting = core.handle(request({ path: '/waiting' }));
    const started = core.handle(request({ path: '/started' }));
    await tick();
    const [idWaiting, idStarted] = agent.framesOf(FrameType.REQ_HEAD).map((f) => f.streamId) as [number, number];
    head(idStarted, 200);
    const startedRes = await started;
    const reader = (startedRes.body as ReadableStream<Uint8Array>).getReader();
    data(idStarted, 'x');
    await reader.read();

    core.dropAllStreams('agent disconnected');
    const waitingRes = await waiting;
    expect(waitingRes.status).toBe(502);
    expect(decode(await readAll(waitingRes.body))).toContain('agent disconnected');
    await expect(reader.read()).rejects.toThrow();
    expect(core.inFlight).toBe(0);
    expect(idWaiting).not.toBe(idStarted);
  });

  it('resets the agent stream when the client stops reading the response', async () => {
    const { core, agent, head, data } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    head(id, 200);
    const res = await pending;
    await (res.body as ReadableStream<Uint8Array>).cancel();
    data(id, 'nobody is listening');
    await tick();
    expect(agent.wasReset(id)).toBe(true);
    expect(core.inFlight).toBe(0);
  });

  it('resets the stream when the request body fails midway', async () => {
    const { core, agent } = setup({ headTimeoutMs: 1000 });
    const failing = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error('client went away'));
      },
    });
    const pending = core.handle(request({ method: 'POST', body: failing }));
    await tick();
    const id = agent.sent[0]!.streamId;
    expect(agent.wasReset(id)).toBe(true);
    expect((await pending).status).toBe(504);
  });

  it('ignores keep-alive text, unknown streams, invalid frames and request-direction frames', async () => {
    const { core, agent, head, end } = setup();
    const pending = core.handle(request());
    await tick();
    const id = agent.sent[0]!.streamId;
    core.onAgentMessage('pong');
    core.onAgentMessage(new Uint8Array([1, 2]));
    core.onAgentMessage(encodeFrame(FrameType.RES_DATA, 9999, text('stray')));
    core.onAgentMessage(encodeFrame(FrameType.REQ_END, id));
    head(id, 200);
    end(id);
    expect((await pending).status).toBe(200);
  });
});

describe('closing an agent socket', () => {
  it('safeCloseCode turns codes that cannot be sent into 1000', () => {
    expect(safeCloseCode(undefined)).toBe(1000);
    expect(safeCloseCode(0)).toBe(1000);
    expect(safeCloseCode(1005)).toBe(1000);
    expect(safeCloseCode(1006)).toBe(1000);
    expect(safeCloseCode(1001)).toBe(1001);
    expect(safeCloseCode(4000)).toBe(4000);
  });

  it('uses "replaced" as the reason an old agent is told to exit', () => {
    expect(REPLACED).toBe('replaced');
  });
});
