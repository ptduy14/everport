// The relay Worker built by tsup, running in the real Cloudflare runtime (workerd, through `wrangler dev`),
// with the real agent connected to it. No Cloudflare account involved. Run with `npm run test:e2e`.
import { createHash } from 'node:crypto';
import { CODE_VERSION } from '@everport/relay';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RelayAgent } from './agent.js';
import { buildWorker, startWorkerd, type WorkerdRelay } from './testing/e2e-helpers.js';
import { SECRET, readBody, silentLogger, sleep, startOrigin, waitFor, type Origin } from './testing/helpers.js';

const TUNNEL = 'fe';
let relay: WorkerdRelay;

beforeAll(async () => {
  relay = await startWorkerd({ workerFile: buildWorker(), tunnel: TUNNEL, secret: SECRET });
});
afterAll(async () => {
  await relay?.stop();
});

const cleanup: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function serve(
  handler: Parameters<typeof startOrigin>[0],
  timings?: ConstructorParameters<typeof RelayAgent>[0]['timings'],
) {
  const origin: Origin = await startOrigin(handler);
  cleanup.push(() => origin.close());
  const agent = new RelayAgent({ secret: SECRET, logger: silentLogger, ...(timings && { timings }) });
  cleanup.push(() => agent.stop());
  await agent.addTunnel({ name: TUNNEL, url: relay.url, target: origin.url });
  await waitFor(() => agent.status().tunnels[0]?.state === 'connected', 20_000);
  return { origin, agent };
}

const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');

describe('the relay Worker in workerd', () => {
  it('names itself and its tunnel on /__ep/version, without needing an agent', async () => {
    const res = await fetch(`${relay.url}/__ep/version`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ name: 'everport-relay', codeVersion: CODE_VERSION, tunnel: TUNNEL });
  });

  it('answers 503 while no agent is connected', async () => {
    const res = await fetch(`${relay.url}/anything`);
    expect(res.status).toBe(503);
    expect(await res.text()).toBe('tunnel offline\n');
  });

  it('answers 426 to /__connect without an upgrade', async () => {
    expect((await fetch(`${relay.url}/__connect`)).status).toBe(426);
  });

  it('carries a request to the local service and its answer back through the Durable Object', async () => {
    const t = await serve((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'origin' });
      res.end('hello from the real agent');
    });
    const res = await fetch(`${relay.url}/hello?x=1`, { headers: { 'x-test': 'yes' } });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-from')).toBe('origin');
    expect(await res.text()).toBe('hello from the real agent');
    expect(t.origin.seen[0]).toMatchObject({ method: 'GET', url: '/hello?x=1' });
    expect(t.origin.seen[0]!.headers['x-test']).toBe('yes');
  });

  it('delivers a 150 KB upload intact and returns a 5 MB response intact', async () => {
    const upload = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const big = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    await serve(async (req, res) => {
      if (req.url === '/big') return void res.end(big);
      res.end(sha256(await readBody(req)));
    });
    expect(await (await fetch(`${relay.url}/up`, { method: 'POST', body: upload })).text()).toBe(sha256(upload));
    expect(sha256(new Uint8Array(await (await fetch(`${relay.url}/big`)).arrayBuffer()))).toBe(sha256(big));
  });

  it('streams a response as it is written, and passes 204 and redirects through', async () => {
    await serve(async (req, res) => {
      if (req.url === '/none') return void res.writeHead(204).end();
      if (req.url === '/old') return void res.writeHead(302, { location: '/new' }).end();
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const n of [1, 2, 3]) {
        res.write(`tick ${n}\n`);
        await sleep(400);
      }
      res.end();
    });
    const started = Date.now();
    const reader = (await fetch(`${relay.url}/sse`)).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toContain('tick 1');
    const firstAt = Date.now() - started;
    while (!(await reader.read()).done);
    expect(Date.now() - started).toBeGreaterThan(firstAt + 500);

    expect((await fetch(`${relay.url}/none`)).status).toBe(204);
    const redirect = await fetch(`${relay.url}/old`, { redirect: 'manual' });
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/new']);
  });

  it('still serves after the Durable Object has had time to hibernate', async () => {
    const t = await serve((_req, res) => void res.end('awake'));
    expect(await (await fetch(`${relay.url}/before`)).text()).toBe('awake');
    await sleep(15_000); // a Durable Object with only idle sockets can sleep after about 10 seconds
    expect(await (await fetch(`${relay.url}/after`)).text()).toBe('awake');
    expect(t.agent.status().tunnels[0]!.state).toBe('connected');
  }, 60_000);

  it('tells the old agent it was replaced when a new agent takes the tunnel', async () => {
    const first = await serve((_req, res) => void res.end('first'));
    const origin2 = await startOrigin((_req, res) => void res.end('second'));
    cleanup.push(() => origin2.close());
    const second = new RelayAgent({ secret: SECRET, logger: silentLogger });
    cleanup.push(() => second.stop());
    await second.addTunnel({ name: TUNNEL, url: relay.url, target: origin2.url });
    await waitFor(() => first.agent.status().tunnels[0]!.state === 'replaced', 20_000);
    await waitFor(() => second.status().tunnels[0]!.state === 'connected', 20_000);
    expect(await (await fetch(`${relay.url}/who`)).text()).toBe('second');
  });

  it('keeps the agent out when its token does not match the secret', async () => {
    const origin = await startOrigin((_req, res) => void res.end('x'));
    cleanup.push(() => origin.close());
    const stranger = new RelayAgent({
      secret: 'not-the-secret',
      logger: silentLogger,
      timings: { backoffBaseMs: 200 },
    });
    cleanup.push(() => stranger.stop());
    await stranger.addTunnel({ name: TUNNEL, url: relay.url, target: origin.url });
    await sleep(1500);
    expect(stranger.status().tunnels[0]).toMatchObject({ state: 'connecting' });
    expect(stranger.status().tunnels[0]!.lastError).toBeTruthy();
  });

  it('fails requests with a 502 when the agent disappears while one is waiting', async () => {
    const t = await serve(async (_req, res) => {
      await sleep(10_000);
      res.end('never');
    });
    const pending = fetch(`${relay.url}/hang`);
    await waitFor(() => t.agent.status().tunnels[0]!.inFlight === 1, 10_000);
    t.agent.stop();
    const res = await pending;
    expect([502, 503]).toContain(res.status);
  });

  it('measures whether a plain text stream reaches the caller chunk by chunk (workerd)', async () => {
    await serve(async (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      for (const n of [1, 2, 3]) {
        res.write(`line ${n}\n`);
        await sleep(500);
      }
      res.end();
    });
    for (const encoding of ['identity', 'gzip']) {
      const started = Date.now();
      const res = await fetch(`${relay.url}/lines`, { headers: { 'accept-encoding': encoding } });
      const reader = res.body!.getReader();
      await reader.read();
      const firstAt = Date.now() - started;
      while (!(await reader.read()).done);
      const totalAt = Date.now() - started;
      console.log(
        `[measure] text/plain, accept-encoding ${encoding}: first chunk after ${firstAt} ms, whole body after ${totalAt} ms` +
          ` (${firstAt < totalAt - 500 ? 'streamed' : 'BUFFERED'})`,
      );
    }
  });

  it('keeps serving after a caller gives up midway, and measures when the local service notices', async () => {
    let closedAt = 0;
    const t = await serve(async (req, res) => {
      if (req.url === '/ok') return void res.end('still fine');
      res.on('close', () => (closedAt = Date.now()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const until = Date.now() + 80_000;
      while (!closedAt && Date.now() < until) {
        res.write('data data data');
        await sleep(50);
      }
    });
    const controller = new AbortController();
    const res = await fetch(`${relay.url}/endless`, { signal: controller.signal });
    await res.body!.getReader().read();
    const abortedAt = Date.now();
    controller.abort();

    // workerd does not tell the Worker quickly that the caller left (a deployed preview took about 30 s):
    // the wait is a measurement, not a requirement. What must hold is that the tunnel is not stuck.
    await waitFor(() => closedAt > 0, 40_000).catch(() => {});
    console.log(
      closedAt > 0
        ? `[measure] the local service saw the caller leave after ${closedAt - abortedAt} ms (workerd)`
        : '[measure] the local service did not see the caller leave within 40 s (workerd)',
    );
    expect(await (await fetch(`${relay.url}/ok`)).text()).toBe('still fine');
    expect(t.agent.status().tunnels[0]!.state).toBe('connected');
  }, 120_000);
});
