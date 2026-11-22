// The real thing, on the real Cloudflare account that wrangler is logged in to: RelayDeployer creates a relay
// Worker and previews, the real agent connects to the real Durable Object, requests go through.
// It creates a Worker called ep-smoke-<random> and removes it again, whatever happens. Slow, and it needs a login.
// Run with:  $env:EVERPORT_CLOUDFLARE='1'; npm run test:e2e
import { createHash } from 'node:crypto';
import {
  NodeFileSystem,
  NodeRelayProbe,
  NodeWranglerRunner,
  RelayDeployer,
  defaultRandomHex,
  loadOrCreateRelaySecret,
  type CreatedTunnel,
} from '@everport/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { RelayAgent } from './agent.js';
import { makeLayout } from './testing/daemon-helpers.js';
import { buildWorker } from './testing/e2e-helpers.js';
import { readBody, silentLogger, sleep, startOrigin, waitFor, type Origin } from './testing/helpers.js';

const enabled = process.env['EVERPORT_CLOUDFLARE'] === '1';
const WORKER = `ep-smoke-${defaultRandomHex(3)}`;
const sha256 = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
const measure = (what: string, ms: number) => console.log(`[measure] ${what}: ${ms} ms`);

describe.skipIf(!enabled)(`the relay on Cloudflare (Worker ${WORKER})`, () => {
  const setupCleanup: (() => Promise<void> | void)[] = [];
  let deployer: RelayDeployer;
  let secret: string;
  const tunnels: Record<string, CreatedTunnel> = {};

  beforeAll(async () => {
    const layout = await makeLayout(setupCleanup, false);
    const fs = new NodeFileSystem();
    secret = await loadOrCreateRelaySecret(fs, layout);
    deployer = new RelayDeployer({
      wrangler: new NodeWranglerRunner(),
      probe: new NodeRelayProbe(),
      fs,
      layout,
      logger: silentLogger,
      workerFile: buildWorker(),
    });
  }, 120_000);

  // Whatever happened above, leave the account as it was.
  afterAll(async () => {
    try {
      await deployer.deleteRelay(WORKER);
      const state = await deployer.probeWorker(WORKER);
      console.log(`[cleanup] Worker ${WORKER} state after cleanup: ${state}`);
    } catch (e) {
      console.log(`[cleanup] FAILED, remove ${WORKER} by hand: ${String(e)}`);
    }
    for (const fn of setupCleanup.splice(0).reverse()) await fn();
  }, 180_000);

  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  async function serve(tunnel: CreatedTunnel, handler: Parameters<typeof startOrigin>[0]) {
    const origin: Origin = await startOrigin(handler);
    cleanup.push(() => origin.close());
    const agent = new RelayAgent({ secret, logger: silentLogger });
    cleanup.push(() => agent.stop());
    await agent.addTunnel({ name: tunnel.name, url: tunnel.url, target: origin.url });
    await waitFor(() => agent.status().tunnels[0]?.state === 'connected', 30_000);
    return { origin, agent };
  }

  it('starts with a login and a free Worker name', async () => {
    expect(await deployer.isLoggedIn({ fresh: true })).toBe(true);
    expect(await deployer.probeWorker(WORKER)).toBe('none');
  });

  it('creates three tunnels: the Worker with the first, the other two together, each checked as it is made', async () => {
    const started = Date.now();
    const created = await deployer.createTunnels({
      workerName: WORKER,
      secret,
      taken: [],
      labels: ['fe', 'be', 'cms'],
    });
    measure('three tunnels created and verified', Date.now() - started);
    for (const tunnel of created) tunnels[tunnel.label] = tunnel;

    expect(created.map((c) => c.name)).toEqual(['fe', 'be', 'cms']);
    for (const tunnel of created) {
      expect(tunnel.url).toBe(`https://${tunnel.name}-${WORKER}.${tunnel.subdomain}.workers.dev`);
      expect(await deployer.checkTunnel(tunnel.url, tunnel.name)).toEqual({ health: 'ok', codeVersion: '1' });
      expect(await deployer.previewExists(WORKER, tunnel.name)).toBe(true);
    }
    expect(await deployer.probeWorker(WORKER)).toBe('previews-only');
  }, 240_000);

  it('carries requests, uploads and large responses through the real Durable Object', async () => {
    const upload = Uint8Array.from({ length: 150_000 }, (_, i) => i % 251);
    const big = Buffer.alloc(5 * 1024 * 1024);
    for (let i = 0; i < big.length; i++) big[i] = (i * 31) % 251;
    const t = await serve(tunnels['fe']!, async (req, res) => {
      if (req.url === '/big') return void res.end(big);
      if (req.url === '/none') return void res.writeHead(204).end();
      if (req.url === '/old') return void res.writeHead(302, { location: '/new' }).end();
      if (req.method === 'POST') return void res.end(sha256(await readBody(req)));
      res.writeHead(200, { 'content-type': 'text/plain', 'x-from': 'origin' });
      res.end('hello through Cloudflare');
    });
    const url = tunnels['fe']!.url;
    const started = Date.now();
    const res = await fetch(`${url}/hello?x=1`, { headers: { 'x-test': 'yes' } });
    measure('first request through the relay', Date.now() - started);
    expect(res.status).toBe(200);
    expect(res.headers.get('x-from')).toBe('origin');
    expect(await res.text()).toBe('hello through Cloudflare');
    expect(t.origin.seen[0]).toMatchObject({ method: 'GET', url: '/hello?x=1' });
    expect(t.origin.seen[0]!.headers['x-test']).toBe('yes');

    expect(await (await fetch(`${url}/up`, { method: 'POST', body: upload })).text()).toBe(sha256(upload));
    const bigStarted = Date.now();
    expect(sha256(new Uint8Array(await (await fetch(`${url}/big`)).arrayBuffer()))).toBe(sha256(big));
    measure('5 MB response', Date.now() - bigStarted);
    expect((await fetch(`${url}/none`)).status).toBe(204);
    const redirect = await fetch(`${url}/old`, { redirect: 'manual' });
    expect([redirect.status, redirect.headers.get('location')]).toEqual([302, '/new']);
  }, 120_000);

  it('streams server-sent events as they are written, and measures plain-text streaming', async () => {
    await serve(tunnels['fe']!, async (req, res) => {
      const type = req.url === '/sse' ? 'text/event-stream' : 'text/plain';
      res.writeHead(200, { 'content-type': type });
      for (const n of [1, 2, 3]) {
        res.write(`line ${n}\n`);
        await sleep(500);
      }
      res.end();
    });
    const url = tunnels['fe']!.url;
    const timeIt = async (path: string, encoding: string) => {
      const started = Date.now();
      const reader = (await fetch(`${url}${path}`, { headers: { 'accept-encoding': encoding } })).body!.getReader();
      await reader.read();
      const first = Date.now() - started;
      while (!(await reader.read()).done);
      const total = Date.now() - started;
      console.log(
        `[measure] ${path} (accept-encoding ${encoding}): first chunk ${first} ms, whole body ${total} ms (${first < total - 500 ? 'streamed' : 'BUFFERED'})`,
      );
      return { first, total };
    };
    const sse = await timeIt('/sse', 'gzip');
    expect(sse.first).toBeLessThan(sse.total - 500); // SSE must arrive as it is written
    await timeIt('/lines', 'identity');
    await timeIt('/lines', 'gzip');
  }, 120_000);

  it('still serves after the Durable Object has had time to hibernate', async () => {
    const t = await serve(tunnels['fe']!, (_req, res) => void res.end('awake'));
    expect(await (await fetch(`${tunnels['fe']!.url}/before`)).text()).toBe('awake');
    await sleep(20_000);
    const started = Date.now();
    expect(await (await fetch(`${tunnels['fe']!.url}/after`)).text()).toBe('awake');
    measure('first request after 20 s idle', Date.now() - started);
    expect(t.agent.status().tunnels[0]!.state).toBe('connected');
  }, 120_000);

  it('pushes the old agent out when a new agent takes the tunnel', async () => {
    const first = await serve(tunnels['fe']!, (_req, res) => void res.end('first'));
    const origin2 = await startOrigin((_req, res) => void res.end('second'));
    cleanup.push(() => origin2.close());
    const second = new RelayAgent({ secret, logger: silentLogger });
    cleanup.push(() => second.stop());
    await second.addTunnel({ name: 'fe', url: tunnels['fe']!.url, target: origin2.url });
    await waitFor(() => first.agent.status().tunnels[0]!.state === 'replaced', 30_000);
    await waitFor(() => second.status().tunnels[0]!.state === 'connected', 30_000);
    expect(await (await fetch(`${tunnels['fe']!.url}/who`)).text()).toBe('second');
  }, 120_000);

  it('keeps out an agent that has the wrong secret', async () => {
    const origin = await startOrigin((_req, res) => void res.end('x'));
    cleanup.push(() => origin.close());
    const stranger = new RelayAgent({
      secret: 'not-the-secret',
      logger: silentLogger,
      timings: { backoffBaseMs: 300 },
    });
    cleanup.push(() => stranger.stop());
    await stranger.addTunnel({ name: 'fe', url: tunnels['fe']!.url, target: origin.url });
    await sleep(3000);
    expect(stranger.status().tunnels[0]).toMatchObject({ state: 'connecting' });
    expect(stranger.status().tunnels[0]!.lastError).toBeTruthy();
  }, 60_000);

  it('fails a waiting request with a 5xx when the agent disappears', async () => {
    const t = await serve(tunnels['fe']!, async (_req, res) => {
      await sleep(15_000);
      res.end('never');
    });
    const pending = fetch(`${tunnels['fe']!.url}/hang`);
    await waitFor(() => t.agent.status().tunnels[0]!.inFlight === 1, 20_000);
    t.agent.stop();
    const res = await pending;
    expect([502, 503]).toContain(res.status);
  }, 60_000);

  it('keeps serving after a caller gives up midway, and measures when the local service notices', async () => {
    let closedAt = 0;
    await serve(tunnels['fe']!, async (req, res) => {
      if (req.url === '/ok') return void res.end('still fine');
      res.on('close', () => (closedAt = Date.now()));
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const until = Date.now() + 100_000;
      while (!closedAt && Date.now() < until) {
        res.write('data data data\n\n');
        await sleep(100);
      }
    });
    const controller = new AbortController();
    const res = await fetch(`${tunnels['fe']!.url}/endless`, { signal: controller.signal });
    await res.body!.getReader().read();
    const abortedAt = Date.now();
    controller.abort();
    await waitFor(() => closedAt > 0, 90_000).catch(() => {});
    console.log(
      closedAt > 0
        ? `[measure] the local service saw the caller leave after ${closedAt - abortedAt} ms (Cloudflare)`
        : '[measure] the local service did NOT see the caller leave within 90 s (Cloudflare)',
    );
    expect(await (await fetch(`${tunnels['fe']!.url}/ok`)).text()).toBe('still fine');
  }, 180_000);

  it('removes a preview, sees it gone, and brings it back at the same address', async () => {
    const be = tunnels['be']!;
    const removeStarted = Date.now();
    await deployer.removeTunnel(WORKER, be.name);
    measure('preview removed', Date.now() - removeStarted);
    expect(await deployer.previewExists(WORKER, be.name)).toBe(false);

    const goneStarted = Date.now();
    await waitFor(() => false, 0).catch(() => {});
    let health = (await deployer.checkTunnel(be.url, be.name)).health;
    while (health !== 'not-found' && Date.now() - goneStarted < 30_000) {
      await sleep(500);
      health = (await deployer.checkTunnel(be.url, be.name)).health;
    }
    measure(`address answers "${health}" after removal`, Date.now() - goneStarted);
    expect(health).toBe('not-found');

    const recreateStarted = Date.now();
    const back = await deployer.recreateTunnel({ workerName: WORKER, name: be.name, label: 'be', secret });
    measure('preview recreated and verified', Date.now() - recreateStarted);
    expect(back.url).toBe(be.url);
    expect((await deployer.checkTunnel(be.url, be.name)).health).toBe('ok');
  }, 180_000);

  it('removes every tunnel and then the Worker, leaving nothing behind', async () => {
    for (const tunnel of Object.values(tunnels)) await deployer.removeTunnel(WORKER, tunnel.name);
    for (const tunnel of Object.values(tunnels)) expect(await deployer.previewExists(WORKER, tunnel.name)).toBe(false);
    await deployer.deleteRelay(WORKER);
    expect(await deployer.probeWorker(WORKER)).toBe('none');
  }, 180_000);
});
