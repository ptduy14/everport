import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { gzipSync } from 'node:zlib';
import { FakeRelay } from '@everport/relay/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { RelayAgent, type RelayAgentOptions } from './agent.js';
import { buildTargetUrl } from './connection.js';
import { FAST, SECRET, readBody, silentLogger, sleep, startOrigin, waitFor, type Origin } from './testing/helpers.js';

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

type Handler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

async function startRelay(tunnel: string, secret = SECRET, port = 0) {
  const relay = new FakeRelay({ secret, tunnel, headTimeoutMs: 2000 });
  const base = await relay.start(port);
  cleanup.push(() => relay.stop());
  return { relay, base, port: Number(new URL(base).port) };
}

async function startService(handler: Handler): Promise<Origin> {
  const origin = await startOrigin(handler);
  cleanup.push(() => origin.close());
  return origin;
}

function newAgent(over: Partial<RelayAgentOptions> = {}): RelayAgent {
  const agent = new RelayAgent({ secret: SECRET, logger: silentLogger, timings: FAST, ...over });
  cleanup.push(() => agent.stop());
  return agent;
}

/** One relay, one local service and an agent serving it, already connected. */
async function serve(handler: Handler, name = 'fe') {
  const { relay, base } = await startRelay(name);
  const origin = await startService(handler);
  const agent = newAgent();
  await agent.addTunnel({ name, url: base, target: origin.url });
  await waitFor(() => relay.connectedAgents === 1);
  return { relay, base, origin, agent };
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('RelayAgent: forwarding requests', () => {
  it('carries a request to the local service and its answer back', async () => {
    const t = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'origin' });
      res.end('hello');
    });
    const res = await fetch(`${t.base}/hello?x=1`, { headers: { 'x-test': 'yes' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-from')).toBe('origin');
    expect(await res.text()).toBe('hello');
    const seen = t.origin.seen[0]!;
    expect(seen.method).toBe('GET');
    expect(seen.url).toBe('/hello?x=1');
    expect(seen.headers['x-test']).toBe('yes');
    expect(seen.headers['accept-encoding']).toBe('identity');
  });

  it('delivers a 150 KB upload byte for byte', async () => {
    const upload = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const t = await serve(async (req, res) => {
      res.end(sha256(await readBody(req)));
    });
    const res = await fetch(`${t.base}/upload`, { method: 'POST', body: upload });
    expect(await res.text()).toBe(sha256(upload));
  });

  it('returns a 5 MB response intact', async () => {
    const payload = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < payload.length; i++) payload[i] = (i * 31) % 251;
    const t = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(payload);
    });
    const res = await fetch(`${t.base}/big`);
    expect(sha256(new Uint8Array(await res.arrayBuffer()))).toBe(sha256(payload));
  });

  it('streams a response as the local service writes it', async () => {
    const t = await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const n of [1, 2, 3]) {
        res.write(`tick ${n}\n`);
        await sleep(150);
      }
      res.end();
    });
    const started = Date.now();
    const reader = (await fetch(`${t.base}/sse`)).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('tick 1');
    const firstAt = Date.now() - started;
    while (!(await reader.read()).done);
    expect(Date.now() - started).toBeGreaterThan(firstAt + 200);
  });

  it('passes a 204 through with no body', async () => {
    const t = await serve((_req, res) => void res.writeHead(204).end());
    const res = await fetch(`${t.base}/none`);
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
  });

  it('passes a redirect through without following it', async () => {
    const t = await serve((_req, res) => void res.writeHead(302, { location: '/elsewhere' }).end());
    const res = await fetch(`${t.base}/old`, { redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/elsewhere');
    expect(t.origin.seen).toHaveLength(1);
  });

  it('decodes a body the local service compressed anyway and drops content-encoding', async () => {
    const t = await serve((_req, res) => {
      res.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      res.end(gzipSync('plain text'));
    });
    const res = await fetch(`${t.base}/enc`);
    expect(res.headers.get('content-encoding')).toBeNull();
    expect(await res.text()).toBe('plain text');
  });

  it('answers 502 with the reason when the local service is not running', async () => {
    const { relay, base } = await startRelay('fe');
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.connectedAgents === 1);
    const res = await fetch(`${base}/anything`);
    expect(res.status).toBe(502);
    expect(await res.text()).toContain('local server error');
  });

  it('stops the local call when the caller gives up midway', async () => {
    let closed = false;
    const t = await serve(async (_req, res) => {
      res.on('close', () => (closed = true));
      res.writeHead(200);
      while (!closed) {
        res.write('data data data');
        await sleep(20);
      }
    });
    const controller = new AbortController();
    const res = await fetch(`${t.base}/endless`, { signal: controller.signal });
    await res.body!.getReader().read();
    controller.abort();
    await waitFor(() => closed);
  });

  it('keeps a path prefix of the target', async () => {
    const { relay, base } = await startRelay('fe');
    const origin = await startService((_req, res) => void res.end('ok'));
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: base, target: `${origin.url}/api/` });
    await waitFor(() => relay.connectedAgents === 1);
    await fetch(`${base}/users?id=7`);
    expect(origin.seen[0]!.url).toBe('/api/users?id=7');
  });
});

describe('RelayAgent: connection lifecycle', () => {
  it('reports connecting, then connected, and counts requests in flight', async () => {
    const { relay, base } = await startRelay('fe');
    const origin = await startService(async (_req, res) => {
      await sleep(300);
      res.end('late');
    });
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: base, target: origin.url });
    expect(agent.status().tunnels[0]).toMatchObject({ name: 'fe', url: base, state: 'connecting', inFlight: 0 });
    await waitFor(() => agent.status().tunnels[0]!.state === 'connected');
    expect(agent.status().tunnels[0]!.lastError).toBeUndefined();

    const pending = fetch(`${base}/slow`);
    await waitFor(() => agent.status().tunnels[0]!.inFlight === 1);
    await pending;
    await waitFor(() => agent.status().tunnels[0]!.inFlight === 0);
    expect(relay.connectedAgents).toBe(1);
  });

  it('reconnects by itself when the relay goes away and comes back at the same address', async () => {
    const first = await startRelay('fe');
    const origin = await startService((_req, res) => void res.end('still here'));
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: first.base, target: origin.url });
    await waitFor(() => first.relay.connectedAgents === 1);

    await first.relay.stop();
    await waitFor(() => agent.status().tunnels[0]!.state === 'connecting');
    const second = await startRelay('fe', SECRET, first.port);
    await waitFor(() => second.relay.connectedAgents === 1, 5000);
    expect(await (await fetch(`${second.base}/again`)).text()).toBe('still here');
  });

  it('drops the socket and reconnects when the relay stops answering pings', async () => {
    const relay = new FakeRelay({ secret: SECRET, tunnel: 'fe', autoPong: false });
    const base = await relay.start();
    cleanup.push(() => relay.stop());
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.totalConnections >= 2, 4000);
  });

  it('stays on one connection for as long as the relay answers pings', async () => {
    const { relay, base } = await startRelay('fe');
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await waitFor(() => relay.connectedAgents === 1);
    await sleep(500);
    expect(relay.totalConnections).toBe(1);
    expect(agent.status().tunnels[0]!.state).toBe('connected');
  });

  it('keeps retrying and reports the error when the relay refuses the token', async () => {
    const { relay, base } = await startRelay('fe', 'a-different-secret');
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: base, target: 'http://127.0.0.1:1' });
    await sleep(300);
    const status = agent.status().tunnels[0]!;
    expect(status.state).toBe('connecting');
    expect(status.lastError).toBeTruthy();
    expect(relay.connectedAgents).toBe(0);
  });

  it('stops serving a tunnel that another agent took, and does not take it back', async () => {
    const { relay, base } = await startRelay('fe');
    const origin = await startService((_req, res) => void res.end('x'));
    let idle = 0;
    const first = newAgent({ onIdle: () => idle++ });
    await first.addTunnel({ name: 'fe', url: base, target: origin.url });
    await waitFor(() => relay.connectedAgents === 1);

    const second = newAgent();
    await second.addTunnel({ name: 'fe', url: base, target: origin.url });
    await waitFor(() => first.status().tunnels[0]!.state === 'replaced');
    expect(idle).toBe(1);
    await sleep(300);
    expect(first.status().tunnels[0]!.state).toBe('replaced');
    expect(second.status().tunnels[0]!.state).toBe('connected');
    expect(relay.totalConnections).toBe(2);
    expect(relay.connectedAgents).toBe(1);
  });

  it('aborts requests in flight and closes its sockets on stop', async () => {
    const t = await serve(async (_req, res) => {
      await sleep(5000);
      res.end('never');
    });
    const pending = fetch(`${t.base}/hang`);
    await waitFor(() => t.agent.status().tunnels[0]!.inFlight === 1);
    t.agent.stop();
    expect((await pending).status).toBe(502);
    await waitFor(() => t.relay.connectedAgents === 0);
    expect(t.agent.status().tunnels).toEqual([]);
  });
});

describe('RelayAgent: several tunnels', () => {
  it('serves tunnels independently and lets them be removed and added while running', async () => {
    const fe = await startRelay('fe');
    const be = await startRelay('be');
    const feService = await startService((_req, res) => void res.end('front'));
    const beService = await startService((_req, res) => void res.end('back'));
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: fe.base, target: feService.url });
    await agent.addTunnel({ name: 'be', url: be.base, target: beService.url });
    await waitFor(() => fe.relay.connectedAgents === 1 && be.relay.connectedAgents === 1);
    expect(await (await fetch(`${fe.base}/`)).text()).toBe('front');
    expect(await (await fetch(`${be.base}/`)).text()).toBe('back');

    expect(agent.removeTunnel('be')).toBe(true);
    expect(agent.removeTunnel('be')).toBe(false);
    await waitFor(() => be.relay.connectedAgents === 0);
    expect(await (await fetch(`${fe.base}/`)).text()).toBe('front');
    expect((await fetch(`${be.base}/`)).status).toBe(503);

    await agent.addTunnel({ name: 'be', url: be.base, target: beService.url });
    await waitFor(() => be.relay.connectedAgents === 1);
    expect(await (await fetch(`${be.base}/`)).text()).toBe('back');
  });

  it('keeps the connection when only the target changes, and reconnects when the URL changes', async () => {
    const one = await startRelay('fe');
    const two = await startRelay('fe');
    const a = await startService((_req, res) => void res.end('A'));
    const b = await startService((_req, res) => void res.end('B'));
    const agent = newAgent();
    await agent.addTunnel({ name: 'fe', url: one.base, target: a.url });
    await waitFor(() => one.relay.connectedAgents === 1);

    await agent.addTunnel({ name: 'fe', url: one.base, target: b.url });
    expect(await (await fetch(`${one.base}/`)).text()).toBe('B');
    expect(one.relay.totalConnections).toBe(1);

    await agent.addTunnel({ name: 'fe', url: two.base, target: a.url });
    await waitFor(() => two.relay.connectedAgents === 1 && one.relay.connectedAgents === 0);
    expect(await (await fetch(`${two.base}/`)).text()).toBe('A');
  });

  it('is idle only after every tunnel was taken over, not when a tunnel is removed', async () => {
    const fe = await startRelay('fe');
    const be = await startRelay('be');
    const target = 'http://127.0.0.1:1';
    let idle = 0;
    const agent = newAgent({ onIdle: () => idle++ });
    await agent.addTunnel({ name: 'fe', url: fe.base, target });
    await agent.addTunnel({ name: 'be', url: be.base, target });
    await waitFor(() => fe.relay.connectedAgents === 1 && be.relay.connectedAgents === 1);

    const rival = newAgent();
    await rival.addTunnel({ name: 'fe', url: fe.base, target });
    await waitFor(() => agent.status().tunnels.some((t) => t.state === 'replaced'));
    expect(idle).toBe(0);
    await rival.addTunnel({ name: 'be', url: be.base, target });
    await waitFor(() => idle === 1);

    const quiet = newAgent({ onIdle: () => idle++ });
    const other = await startRelay('x');
    await quiet.addTunnel({ name: 'x', url: other.base, target });
    await waitFor(() => other.relay.connectedAgents === 1);
    quiet.removeTunnel('x');
    await sleep(100);
    expect(idle).toBe(1);
  });
});

describe('RelayAgent: input checks', () => {
  it.each([
    [
      'a tunnel name with spaces and capitals',
      { name: 'Bad Name', url: 'http://127.0.0.1:9', target: 'http://127.0.0.1:9' },
      'INVALID_NAME',
    ],
    ['a URL that is not http(s)', { name: 'fe', url: 'ftp://x', target: 'http://127.0.0.1:9' }, 'INVALID_TARGET'],
    ['a target that is not a URL', { name: 'fe', url: 'http://127.0.0.1:9', target: 'nope' }, 'INVALID_TARGET'],
  ])('rejects %s', async (_name, config, code) => {
    await expect(newAgent().addTunnel(config)).rejects.toMatchObject({ code });
  });
});

describe('buildTargetUrl', () => {
  it.each([
    ['http://127.0.0.1:3000', '/a?b=1', 'http://127.0.0.1:3000/a?b=1'],
    ['http://127.0.0.1:3000/', '/', 'http://127.0.0.1:3000/'],
    ['http://127.0.0.1:3000/api', '/users', 'http://127.0.0.1:3000/api/users'],
    ['http://127.0.0.1:3000/api/', '/users?id=7', 'http://127.0.0.1:3000/api/users?id=7'],
  ])('joins %s and %s', (target, path, expected) => {
    expect(buildTargetUrl(target, path)).toBe(expected);
  });
});
