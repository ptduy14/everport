// The whole product, end to end: the Everport facade on the real Cloudflare account, with the real background agent.
// add, down, up, a lost preview, a killed agent, stop and start, doctor, remove. Creates a Worker called
// ep-smoke-<random> and removes it again, whatever happens. Slow, and it needs a login.
// Run with:  $env:EVERPORT_CLOUDFLARE='1'; npm run test:e2e -- packages/agent/src/everport.e2e.test.ts
import { execFileSync } from 'node:child_process';
import {
  NodeFileSystem,
  NodeProcessTable,
  NodeWranglerRunner,
  defaultRandomHex,
  type Everport,
  type TunnelStatus,
} from '@everport/core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createEverport } from './create-everport.js';
import { readAgentState } from './state.js';
import { makeLayout } from './testing/daemon-helpers.js';
import { buildWorker } from './testing/e2e-helpers.js';
import { sleep, startOrigin, waitFor, type Origin } from './testing/helpers.js';
import { fileURLToPath } from 'node:url';

const enabled = process.env['EVERPORT_CLOUDFLARE'] === '1';
const WORKER = `ep-smoke-${defaultRandomHex(3)}`;
const measure = (what: string, ms: number) => console.log(`[measure] ${what}: ${ms} ms`);

const agentDir = fileURLToPath(new URL('..', import.meta.url));
const tsupCli = fileURLToPath(new URL('../../../node_modules/tsup/dist/cli-default.js', import.meta.url));
const agentEntry = fileURLToPath(new URL('../dist/agent.js', import.meta.url));

/** The body at a public address, or the status when it is not a success. */
async function ask(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  const body = await res.text();
  if (!res.ok) console.log(`[ask] ${url} -> HTTP ${res.status} ${body.replace(/\s+/g, ' ').slice(0, 160)}`);
  return res.ok ? body : `HTTP ${res.status}`;
}

/** Polls an address until it answers `expected` (or the time is up) and returns the last answer. */
async function waitForAnswer(url: string, expected: string, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  for (;;) {
    const answer = await ask(url);
    if (answer === expected || Date.now() >= deadline) return answer;
    await sleep(300);
  }
}

describe.skipIf(!enabled)(`Everport on Cloudflare with the real agent (Worker ${WORKER})`, () => {
  const setupCleanup: (() => Promise<void> | void)[] = [];
  const fs = new NodeFileSystem();
  const processTable = new NodeProcessTable();
  const wrangler = new NodeWranglerRunner();
  let everport: Everport;
  let origin: Origin;
  let dataDir: string;
  let agentStateFile: string;
  const fe = { url: '' };

  beforeAll(async () => {
    const layout = await makeLayout(setupCleanup, false);
    dataDir = layout.dataDir;
    agentStateFile = layout.agentStateFile;
    execFileSync(process.execPath, [tsupCli], { cwd: agentDir, stdio: 'pipe' });
    origin = await startOrigin((_req, res) => void res.end('hello from everport'));
    everport = createEverport({ dataDir, workerFile: buildWorker(), agentEntry, workerName: WORKER });
  }, 180_000);

  // Whatever happened above: stop the agent, remove the Worker, leave the account as it was.
  afterAll(async () => {
    try {
      await everport?.down();
    } catch (e) {
      console.log(`[cleanup] down failed: ${String(e)}`);
      const state = await readAgentState(fs, agentStateFile);
      if (state && processTable.isAlive(state.pid)) await processTable.killTree(state.pid);
    }
    // Cloudflare takes a moment to show a deletion, so look a few times before calling it still there.
    let gone = false;
    for (let attempt = 0; attempt < 6 && !gone; attempt++) {
      await wrangler.run(['delete', '--name', WORKER, '--force'], { timeoutMs: 120_000 });
      const check = await wrangler.run(['versions', 'list', '--name', WORKER, '--json'], { timeoutMs: 60_000 });
      gone = /10007/.test(check.stderr);
      if (!gone) await sleep(2000);
    }
    console.log(`[cleanup] Worker ${WORKER}: ${gone ? 'gone' : 'STILL THERE, remove it by hand'}`);
    await origin?.close();
    for (const fn of setupCleanup.splice(0).reverse()) await fn();
  }, 240_000);

  const cleanup: (() => Promise<void> | void)[] = [];
  afterEach(async () => {
    for (const fn of cleanup.splice(0).reverse()) await fn();
  });

  const byLabel = (statuses: TunnelStatus[], label: string) => statuses.find((s) => s.label === label)!;

  it('starts logged in, with nothing yet', async () => {
    expect(await everport.isLoggedIn({ fresh: true })).toBe(true);
    expect(await everport.status()).toEqual([]);
  });

  it('adds the first tunnel: relay, preview, agent and a URL that answers (Cloudflare part)', async () => {
    const started = Date.now();
    const status = await everport.add({ target: origin.url, label: 'fe' });
    measure('first add, from the command to an active tunnel', Date.now() - started);
    expect(status).toMatchObject({ label: 'fe', state: 'active', enabled: true });
    fe.url = status.url;
    expect(status.url).toMatch(new RegExp(String.raw`^https://fe-${WORKER}\.[a-z0-9-]+\.workers\.dev$`));
    expect(await ask(fe.url)).toBe('hello from everport');
    measure('first request', Date.now() - started);
  }, 240_000);

  it('adds a second tunnel to the same relay', async () => {
    const started = Date.now();
    const status = await everport.add({ target: origin.url, label: 'be' });
    measure('second add', Date.now() - started);
    expect(status.state).toBe('active');
    expect(await ask(status.url)).toBe('hello from everport');
  }, 240_000);

  it('goes down and comes up again with the same addresses', async () => {
    const downStarted = Date.now();
    expect(await everport.down()).toBe('stopped');
    measure('down', Date.now() - downStarted);
    expect(await waitForAnswer(fe.url, 'HTTP 503')).toBe('HTTP 503');
    expect((await everport.status()).map((s) => s.state)).toEqual(['down', 'down']);

    const upStarted = Date.now();
    const statuses = await everport.up();
    measure('up after a clean down', Date.now() - upStarted);
    expect(statuses.map((s) => s.state)).toEqual(['active', 'active']);
    expect(byLabel(statuses, 'fe').url).toBe(fe.url);
    expect(await ask(fe.url)).toBe('hello from everport');
  }, 240_000);

  it('recovers from a killed agent with nothing done by hand', async () => {
    const state = (await readAgentState(fs, agentStateFile))!;
    await processTable.killTree(state.pid); // a crash: no chance to clean up
    await waitFor(() => !processTable.isAlive(state.pid), 10_000);

    const started = Date.now();
    const statuses = await everport.up();
    measure('up after the agent was killed', Date.now() - started);
    expect(statuses.map((s) => s.state)).toEqual(['active', 'active']);
    expect(await ask(fe.url)).toBe('hello from everport');
    expect((await readAgentState(fs, agentStateFile))!.pid).not.toBe(state.pid);
  }, 240_000);

  it('notices a preview that was lost and brings it back at the same address', async () => {
    const be = byLabel(await everport.status(), 'be');
    await wrangler.run(['preview', 'delete', '--name', be.name, '--worker-name', WORKER, '--skip-confirmation'], {
      timeoutMs: 120_000,
    });
    await sleep(1500);

    const checked = byLabel(await everport.status({ health: true }), 'be');
    expect(checked).toMatchObject({ state: 'missing', health: 'not-found' });

    const started = Date.now();
    const statuses = await everport.up();
    measure('up with a lost preview (redeploy and serve)', Date.now() - started);
    expect(byLabel(statuses, 'be')).toMatchObject({ state: 'active', url: be.url });
    // Once a request right after bringing a preview back answered HTTP 500 and could not be reproduced in four more
    // tries: say so if it happens again, and allow a few seconds for the new version to reach every edge.
    const first = await ask(be.url);
    if (first !== 'hello from everport') {
      console.log(`[measure] the first request after bringing a preview back answered "${first}", not yet serving`);
    }
    expect(await waitForAnswer(be.url, 'hello from everport', 20_000)).toBe('hello from everport');
  }, 240_000);

  it('switches one tunnel off and on without touching the other', async () => {
    expect(await everport.stop('fe')).toMatchObject({ state: 'stopped' });
    expect(await waitForAnswer(fe.url, 'HTTP 503')).toBe('HTTP 503');
    expect(await ask(byLabel(await everport.status(), 'be').url)).toBe('hello from everport');

    expect(await everport.start('fe')).toMatchObject({ state: 'active' });
    expect(await ask(fe.url)).toBe('hello from everport');
  }, 120_000);

  it('passes its own health check', async () => {
    const checks = await everport.doctor();
    for (const c of checks)
      console.log(`[doctor] ${c.ok ? 'ok  ' : 'FAIL'} ${c.name}: ${c.detail}${c.hint ? ` (${c.hint})` : ''}`);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    const status = await everport.status({ health: true });
    expect(status.every((s) => s.health === 'ok' && s.outdated === false)).toBe(true);
  }, 240_000);

  it('removes the tunnels, leaving their addresses dead', async () => {
    const urls = (await everport.status()).map((s) => s.url);
    await everport.remove('be');
    await everport.remove('fe');
    expect(await everport.status()).toEqual([]);
    for (const url of urls) expect(await waitForAnswer(url, 'HTTP 404')).toBe('HTTP 404');
    expect(await everport.down()).toBe('stopped');
  }, 240_000);
});
