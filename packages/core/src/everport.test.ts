import { describe, expect, it } from 'vitest';
import { CODE_VERSION } from '@everport/relay';
import { ConfigStore } from './config-store.js';
import { EverportError } from './errors.js';
import { EventBus } from './events.js';
import { Everport, type DoctorCheck } from './everport.js';
import { nullLogger } from './logger.js';
import { createLayout } from './paths.js';
import type { ProcessTable } from './ports.js';
import { RelayDeployer } from './relay/relay-deployer.js';
import { FakeAgentControl } from './testing/fake-agent-control.js';
import { FakeCloudflare } from './testing/fake-cloudflare.js';
import { FakeFs } from './testing/fake-fs.js';

const WORKER = 'everport';

function setup() {
  const fs = new FakeFs().seed('/bundle/worker.js', `// fake relay worker, code version ${CODE_VERSION}`);
  const layout = createLayout({ platform: 'linux', env: {}, home: '/h' }, '/data');
  const cloud = new FakeCloudflare(fs, 'linux');
  cloud.createDelayMs = 1;
  const agent = new FakeAgentControl();
  const events = new EventBus();
  const seen: string[] = [];
  events.on((e) => seen.push(e.type));
  let counter = 0;
  const randomHex = (bytes: number) => (++counter).toString(16).padStart(bytes * 2, '0');
  const deployer = new RelayDeployer({
    wrangler: cloud.wrangler,
    probe: cloud.probe,
    fs,
    layout,
    logger: nullLogger,
    workerFile: '/bundle/worker.js',
    randomHex,
    sleep: async () => {},
  });
  const processTable = {
    isAlive: () => true,
    killTree: async () => {},
    spawnDetached: async () => undefined,
  } as ProcessTable;
  const make = (nodeVersion = 'v24.1.0') =>
    new Everport({
      layout,
      fs,
      logger: nullLogger,
      events,
      deployer,
      agent,
      wrangler: cloud.wrangler,
      processTable,
      pid: 100,
      randomHex,
      sleep: async () => {},
      connectTimeoutMs: 50,
      pollMs: 10,
      nodeVersion,
    });
  const everport = make();
  const store = new ConfigStore(fs, layout.configFile);
  return { fs, layout, cloud, agent, events, seen, everport, store, make, deployer };
}

/** An Everport with tunnels already added, and the agent stopped, as after `everport down`. */
async function withTunnels(...labels: string[]) {
  const s = setup();
  for (const label of labels) await s.everport.add({ target: '3000', label });
  return s;
}

describe('add', () => {
  it('creates the relay with the first tunnel, saves it, and has the agent serve it', async () => {
    const { everport, store, agent, fs, layout, cloud, seen } = setup();
    const status = await everport.add({ target: '3000', label: 'Front end' });

    expect(status).toMatchObject({
      label: 'Front end',
      name: 'front-end',
      target: 'http://127.0.0.1:3000',
      enabled: true,
      state: 'active',
      url: 'https://front-end-everport.example.workers.dev',
    });
    const config = await store.load();
    expect(config.relay).toEqual({
      workerName: WORKER,
      subdomain: 'example',
      codeVersion: CODE_VERSION,
      wranglerVersion: '4.166.0',
    });
    expect(config.tunnels).toEqual([
      { id: status.id, label: 'Front end', name: 'front-end', url: status.url, target: status.target, enabled: true },
    ]);
    expect(agent.running).toBe(true);
    expect(agent.tunnels.get('front-end')).toMatchObject({ url: status.url, target: status.target });
    expect(fs.privatePaths.has(layout.relaySecretFile)).toBe(true);
    expect(cloud.preview(WORKER, 'front-end')!.secret).toBe(fs.text(layout.relaySecretFile)!.trim());
    expect(seen).toEqual(expect.arrayContaining(['tunnel:creating', 'tunnel:ready']));
  });

  it('tells the first tunnel that it also sets up the relay and that this can take a while, and only the first', async () => {
    const { everport, events } = setup();
    const heard: { type: string; message: string }[] = [];
    events.on((e) => heard.push(e));
    await everport.add({ target: '3000', label: 'fe' });
    expect(heard.find((e) => e.type === 'relay:setup')?.message).toMatch(/first tunnel.*10 to 20 seconds.*minute/);
    expect(heard.find((e) => e.type === 'tunnel:creating')?.message).toBe(
      'Creating fe and the relay on Cloudflare (10 to 20 seconds, it varies)',
    );

    heard.length = 0;
    await everport.add({ target: '3301', label: 'be' });
    expect(heard.some((e) => e.type === 'relay:setup')).toBe(false);
    expect(heard.find((e) => e.type === 'tunnel:creating')?.message).toBe('Creating be on Cloudflare');
  });

  it('takes the label from the target when none is given', async () => {
    const { everport } = setup();
    expect(await everport.add({ target: '3000' })).toMatchObject({ label: '127.0.0.1:3000', name: '127-0-0-1-3000' });
  });

  it('uses the same relay for the next tunnel, and does not create the Worker again', async () => {
    const { everport, store, cloud } = setup();
    await everport.add({ target: '3000', label: 'fe' });
    cloud.calls.length = 0;
    await everport.add({ target: '3301', label: 'be' });
    expect((await store.load()).tunnels.map((t) => t.name)).toEqual(['fe', 'be']);
    expect(cloud.worker(WORKER)!.previews.size).toBe(2);
    expect(cloud.calls.some((c) => c.args[0] === 'delete')).toBe(false);
  });

  it('refuses a label that is taken (any case) before touching Cloudflare', async () => {
    const { everport, cloud } = await withTunnels('Front end');
    cloud.calls.length = 0;
    await expect(everport.add({ target: '3001', label: 'front END' })).rejects.toMatchObject({ code: 'TUNNEL_EXISTS' });
    expect(cloud.calls).toHaveLength(0);
  });

  it('refuses two labels that become the same name', async () => {
    const { everport } = await withTunnels('My App');
    await expect(everport.add({ target: '3001', label: 'my-app' })).rejects.toMatchObject({ code: 'TUNNEL_EXISTS' });
  });

  it('refuses a target that is not a port or a URL', async () => {
    const { everport, cloud } = setup();
    await expect(everport.add({ target: 'ftp://nope' })).rejects.toMatchObject({ code: 'INVALID_TARGET' });
    expect(cloud.calls).toHaveLength(0);
  });

  it('asks for a login instead of failing deep inside wrangler, and saves nothing', async () => {
    const { everport, cloud, store, agent } = setup();
    cloud.loggedIn = false;
    await expect(everport.add({ target: '3000' })).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
    expect((await store.load()).tunnels).toEqual([]);
    expect(agent.calls).toEqual([]);
  });

  it('saves nothing when Cloudflare fails', async () => {
    const { everport, cloud, store } = setup();
    cloud.failCommand = { prefix: ['preview', '--name'], text: 'the Cloudflare API is down' };
    await expect(everport.add({ target: '3000' })).rejects.toMatchObject({ code: 'WRANGLER_FAILED' });
    expect((await store.load()).tunnels).toEqual([]);
  });

  it('removes the new preview again when the configuration cannot be saved, so none is left that nothing knows about', async () => {
    const { everport, cloud, fs } = setup();
    fs.rename = async () => {
      throw new Error('disk full');
    };
    await expect(everport.add({ target: '3000', label: 'fe' })).rejects.toThrow('disk full');
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
  });

  it('keeps the tunnel and reports the problem when the agent cannot start', async () => {
    const { everport, agent, store } = setup();
    agent.startFails = new EverportError('AGENT_NOT_RUNNING', 'The agent exited right after starting');
    const status = await everport.add({ target: '3000', label: 'fe' });
    expect(status).toMatchObject({ state: 'failed', error: { code: 'AGENT_NOT_RUNNING' } });
    expect((await store.load()).tunnels).toHaveLength(1);
  });

  it('runs two adds of one process one after the other, never at once and never failing with LOCKED', async () => {
    const { everport, store, cloud } = setup();
    let running = 0;
    let most = 0;
    const original = cloud.probe.version;
    cloud.probe.version = async (url) => {
      most = Math.max(most, ++running);
      try {
        return await original(url);
      } finally {
        running--;
      }
    };
    const results = await Promise.allSettled([
      everport.add({ target: '3000', label: 'a' }),
      everport.add({ target: '3001', label: 'b' }),
    ]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    expect(most).toBe(1);
    expect((await store.load()).tunnels).toHaveLength(2);
  });

  it('lets a stop wait for a Start All of the same window instead of failing', async () => {
    const { everport } = await withTunnels('fe', 'be');
    const results = await Promise.allSettled([everport.up(), everport.stop('fe'), everport.start('fe')]);
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled']);
  });

  it('releases its lock when it is done', async () => {
    const { everport, fs, layout } = setup();
    await everport.add({ target: '3000' });
    expect(await fs.exists(layout.lockFile)).toBe(false);
  });
});

describe('up', () => {
  it('starts the agent and serves every enabled tunnel, leaving the stopped ones alone', async () => {
    const { everport, agent } = await withTunnels('fe', 'be');
    await everport.stop('be');
    await everport.down();

    const statuses = await everport.up();
    expect(statuses.map((s) => [s.label, s.state])).toEqual([
      ['fe', 'active'],
      ['be', 'stopped'],
    ]);
    expect([...agent.tunnels.keys()]).toEqual(['fe']);
  });

  it('brings back a preview that went missing, at the same address, and then serves it', async () => {
    const { everport, cloud, agent } = await withTunnels('fe');
    const [before] = await everport.status();
    await everport.down();
    cloud.worker(WORKER)!.previews.delete('fe');

    const [after] = await everport.up();
    expect(after).toMatchObject({ state: 'active', url: before!.url });
    expect(cloud.preview(WORKER, 'fe')).toBeDefined();
    expect(agent.tunnels.has('fe')).toBe(true);
  });

  it('does not bring a preview back into a Worker that is no longer an Everport relay', async () => {
    const { everport, cloud } = await withTunnels('fe');
    await everport.down();
    cloud.worker(WORKER)!.previews.delete('fe');
    cloud.worker(WORKER)!.regular = true;
    const [after] = await everport.up();
    expect(after).toMatchObject({ state: 'failed', error: { code: 'WORKER_NAME_TAKEN' } });
    expect(cloud.preview(WORKER, 'fe')).toBeUndefined();
  });

  it('takes a tunnel off the running agent before redeploying it, since the check would push the agent out', async () => {
    const { everport, cloud, agent } = await withTunnels('fe');
    cloud.worker(WORKER)!.previews.delete('fe'); // the agent is still running and still has it
    agent.calls.length = 0;
    await everport.up();
    expect(agent.calls.indexOf('removeTunnel fe')).toBeGreaterThanOrEqual(0);
    expect(agent.calls.indexOf('removeTunnel fe')).toBeLessThan(agent.calls.lastIndexOf('addTunnel fe'));
  });

  it('fails only the tunnel whose address is answered by something else, and does not redeploy it', async () => {
    const { everport, cloud, agent } = await withTunnels('fe', 'be');
    await everport.down();
    cloud.shadowed.add('fe-everport.example.workers.dev');
    cloud.calls.length = 0;

    const statuses = await everport.up();
    expect(statuses.find((s) => s.label === 'fe')).toMatchObject({
      state: 'failed',
      error: { code: 'RELAY_MISMATCH' },
    });
    expect(statuses.find((s) => s.label === 'be')).toMatchObject({ state: 'active' });
    expect(agent.tunnels.has('fe')).toBe(false);
    expect(cloud.calls.some((c) => c.args[0] === 'preview')).toBe(false); // not even a look at the preview
  });

  it('does not redeploy a preview that exists but does not answer: another Worker may use the address', async () => {
    const { everport, cloud } = await withTunnels('fe');
    await everport.down();
    cloud.notReadyVersionProbes = 1; // one 404, while the preview does exist on Cloudflare
    const [status] = await everport.up();
    expect(status).toMatchObject({ state: 'failed', error: { code: 'RELAY_MISMATCH' } });
  });

  it('does not redeploy when the network is down, only reports it', async () => {
    const { everport, cloud } = await withTunnels('fe');
    await everport.down();
    cloud.unreachable = true;
    cloud.calls.length = 0;
    const [status] = await everport.up();
    expect(status).toMatchObject({ state: 'failed', error: { code: 'RELAY_UNREACHABLE' } });
    expect(cloud.calls).toHaveLength(0);
  });

  it('keeps serving a connected tunnel whose check timed out, instead of taking it off the agent', async () => {
    const { everport, cloud, agent } = await withTunnels('fe', 'be');
    cloud.unreachable = true; // the probe fails, but the agent's sockets are fine
    const statuses = await everport.up();
    expect(statuses.map((s) => [s.label, s.state])).toEqual([
      ['fe', 'active'],
      ['be', 'active'],
    ]);
    expect([...agent.tunnels.keys()].sort()).toEqual(['be', 'fe']);
  });

  it('says a login is needed to bring a preview back, and still serves the others', async () => {
    const { everport, cloud } = await withTunnels('fe', 'be');
    await everport.down();
    cloud.worker(WORKER)!.previews.delete('fe');
    cloud.loggedIn = false;
    const statuses = await everport.up();
    expect(statuses.find((s) => s.label === 'fe')).toMatchObject({ state: 'failed', error: { code: 'NOT_LOGGED_IN' } });
    expect(statuses.find((s) => s.label === 'be')).toMatchObject({ state: 'active' });
  });

  it('takes tunnels off the agent that the configuration no longer wants', async () => {
    const { everport, agent } = await withTunnels('fe');
    await agent.addTunnel({ name: 'ghost', url: 'https://ghost.example', target: 'http://127.0.0.1:1' });
    await everport.up();
    expect([...agent.tunnels.keys()]).toEqual(['fe']);
  });

  it('does nothing, and does not start the agent, when there is nothing to serve', async () => {
    const { everport, agent } = setup();
    expect(await everport.up()).toEqual([]);
    expect(agent.calls).toEqual([]);
  });

  it('refuses to go on without the relay secret: the tunnels on Cloudflare could not be reached', async () => {
    const { everport, fs, layout } = await withTunnels('fe');
    await fs.remove(layout.relaySecretFile);
    await expect(everport.up()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
  });

  it('fails when the agent cannot start, because there is nothing to serve with', async () => {
    const { everport, agent } = await withTunnels('fe');
    await everport.down();
    agent.startFails = new EverportError('AGENT_NOT_RUNNING', 'cannot start');
    await expect(everport.up()).rejects.toMatchObject({ code: 'AGENT_NOT_RUNNING' });
  });
});

describe('down', () => {
  it('stops the agent and leaves the tunnels and their previews', async () => {
    const { everport, agent, cloud, store } = await withTunnels('fe');
    expect(await everport.down()).toBe('stopped');
    expect(agent.running).toBe(false);
    expect(cloud.worker(WORKER)!.previews.size).toBe(1);
    expect((await store.load()).tunnels).toHaveLength(1);
    expect((await everport.status())[0]).toMatchObject({ state: 'down' });
  });

  it('says so when there was no agent', async () => {
    const { everport } = setup();
    expect(await everport.down()).toBe('not-running');
  });
});

describe('remove', () => {
  it('removes the preview, the agent entry and the configuration entry', async () => {
    const { everport, cloud, agent, store, seen } = await withTunnels('fe', 'be');
    await everport.remove('FE');
    expect([...cloud.worker(WORKER)!.previews.keys()]).toEqual(['be']);
    expect([...agent.tunnels.keys()]).toEqual(['be']);
    expect((await store.load()).tunnels.map((t) => t.label)).toEqual(['be']);
    expect(seen).toContain('tunnel:released');
  });

  it('works when the agent is not running', async () => {
    const { everport, store } = await withTunnels('fe');
    await everport.down();
    await everport.remove('fe');
    expect((await store.load()).tunnels).toEqual([]);
  });

  it('changes nothing when Cloudflare refuses', async () => {
    const { everport, cloud, agent, store } = await withTunnels('fe');
    cloud.failCommand = { prefix: ['preview', 'delete'], text: 'the Cloudflare API is down' };
    await expect(everport.remove('fe')).rejects.toMatchObject({ code: 'WRANGLER_FAILED' });
    expect((await store.load()).tunnels).toHaveLength(1);
    expect(agent.tunnels.has('fe')).toBe(true);
  });

  it('can remove a tunnel from this computer only, without asking Cloudflare', async () => {
    const { everport, cloud, agent, store } = await withTunnels('fe', 'be');
    cloud.failCommand = { prefix: ['preview', 'delete'], text: 'the Cloudflare API is down' };
    cloud.calls.length = 0;
    await everport.remove('fe', { localOnly: true });
    expect(cloud.calls).toEqual([]);
    expect(cloud.preview(WORKER, 'fe')).toBeDefined(); // left on Cloudflare
    expect([...agent.tunnels.keys()]).toEqual(['be']);
    expect((await store.load()).tunnels.map((t) => t.label)).toEqual(['be']);
  });

  it('says TUNNEL_NOT_FOUND for an unknown tunnel', async () => {
    const { everport } = setup();
    await expect(everport.remove('nope')).rejects.toMatchObject({ code: 'TUNNEL_NOT_FOUND' });
  });
});

describe('start and stop', () => {
  it('switches a tunnel off and on, in the configuration and on the agent', async () => {
    const { everport, agent, store } = await withTunnels('fe');
    expect(await everport.stop('fe')).toMatchObject({ enabled: false, state: 'stopped' });
    expect(agent.tunnels.has('fe')).toBe(false);
    expect((await store.load()).tunnels[0]!.enabled).toBe(false);

    expect(await everport.start('fe')).toMatchObject({ enabled: true, state: 'active' });
    expect(agent.tunnels.has('fe')).toBe(true);
  });

  it('only records the choice when the agent is not running', async () => {
    const { everport, agent } = await withTunnels('fe');
    await everport.stop('fe');
    await everport.down();
    agent.calls.length = 0;
    expect(await everport.start('fe')).toMatchObject({ enabled: true, state: 'down' });
    expect(agent.calls).toEqual([]);
  });

  it('says TUNNEL_NOT_FOUND for an unknown tunnel', async () => {
    const { everport } = setup();
    await expect(everport.start('nope')).rejects.toMatchObject({ code: 'TUNNEL_NOT_FOUND' });
  });
});

describe('status', () => {
  it('is empty before any tunnel exists', async () => {
    expect(await setup().everport.status()).toEqual([]);
  });

  it('maps what the agent says to a state', async () => {
    const { everport, agent } = await withTunnels('fe', 'be', 'cms', 'off');
    agent.tunnels.get('be')!.state = 'connecting';
    agent.tunnels.get('be')!.lastError = 'connection refused';
    agent.tunnels.get('cms')!.state = 'replaced';
    await everport.stop('off');

    const by = Object.fromEntries((await everport.status()).map((s) => [s.label, s]));
    expect(by['fe']).toMatchObject({ state: 'active' });
    expect(by['be']).toMatchObject({
      state: 'failed',
      error: { code: 'RELAY_UNREACHABLE', message: 'connection refused' },
    });
    expect(by['cms']).toMatchObject({ state: 'failed', error: { code: 'AGENT_REPLACED' } });
    expect(by['off']).toMatchObject({ state: 'stopped' });
  });

  it('calls a tunnel that is still connecting, with no error yet, down', async () => {
    const { everport, agent } = await withTunnels('fe');
    agent.tunnels.get('fe')!.state = 'connecting';
    expect((await everport.status())[0]).toMatchObject({ state: 'down' });
  });

  it('leaves health out unless asked, and asks only about enabled tunnels when it is', async () => {
    const { everport, cloud } = await withTunnels('fe', 'off');
    await everport.stop('off');
    expect((await everport.status())[0]).not.toHaveProperty('health');
    const asked = new Set<string>();
    const original = cloud.probe.version;
    cloud.probe.version = async (url) => (asked.add(url), original(url));
    const statuses = await everport.status({ health: true });
    expect(statuses.find((s) => s.label === 'fe')).toMatchObject({ health: 'ok', outdated: false });
    expect(statuses.find((s) => s.label === 'off')).not.toHaveProperty('health');
    expect(asked.size).toBe(1);
  });

  it('shows a preview that is gone as missing, and another Worker at the address as failed', async () => {
    const { everport, cloud } = await withTunnels('fe', 'be');
    cloud.worker(WORKER)!.previews.delete('fe');
    cloud.shadowed.add('be-everport.example.workers.dev');
    const by = Object.fromEntries((await everport.status({ health: true })).map((s) => [s.label, s]));
    expect(by['fe']).toMatchObject({ state: 'missing', health: 'not-found' });
    expect(by['be']).toMatchObject({ state: 'failed', health: 'mismatch', error: { code: 'RELAY_MISMATCH' } });
  });

  it('shows a gone preview as missing even when the agent is stopped or still reconnecting', async () => {
    const { everport, cloud, agent } = await withTunnels('fe', 'be');
    cloud.worker(WORKER)!.previews.delete('fe');
    cloud.worker(WORKER)!.previews.delete('be');
    agent.tunnels.get('be')!.state = 'connecting';
    const reconnecting = Object.fromEntries((await everport.status({ health: true })).map((s) => [s.label, s]));
    expect(reconnecting['be']).toMatchObject({ state: 'missing', health: 'not-found' });
    await everport.down();
    expect((await everport.status({ health: true }))[0]).toMatchObject({ state: 'missing', health: 'not-found' });
  });

  it('flags a relay that runs older code than this Everport', async () => {
    const { everport, fs } = setup();
    fs.seed('/bundle/worker.js', '// fake relay worker, code version 0');
    await everport.add({ target: '3000', label: 'fe' });
    expect((await everport.status({ health: true }))[0]).toMatchObject({ outdated: true });
    expect(CODE_VERSION).not.toBe('0');
  });
});

describe('doctor', () => {
  const byName = (checks: DoctorCheck[], name: string): DoctorCheck => {
    const found = checks.find((c) => c.name === name);
    if (!found) throw new Error(`no doctor check named "${name}"`);
    return found;
  };

  it('passes every check on a healthy setup', async () => {
    const { everport } = await withTunnels('fe');
    const checks = await everport.doctor();
    expect(checks.map((c) => c.name)).toEqual([
      'node',
      'wrangler',
      'cloudflare login',
      'data folder',
      'configuration',
      'relay',
      'relay secret',
      'tunnel fe',
      'agent',
    ]);
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('says there is no relay yet before the first add', async () => {
    const checks = await setup().everport.doctor();
    expect(byName(checks, 'relay')).toMatchObject({ ok: true, detail: expect.stringContaining('none yet') });
    expect(checks.filter((c) => !c.ok)).toEqual([]);
  });

  it('reports each problem with what to do, and still runs the other checks', async () => {
    const { make, cloud } = await withTunnels('fe');
    cloud.wranglerVersion = '4.0.0';
    cloud.loggedIn = false;
    const checks = await make('v20.1.0').doctor();
    expect(byName(checks, 'node')).toMatchObject({ ok: false, hint: expect.stringContaining('22') });
    expect(byName(checks, 'wrangler')).toMatchObject({ ok: false, detail: expect.stringContaining('4.0.0') });
    expect(byName(checks, 'cloudflare login')).toMatchObject({
      ok: false,
      hint: expect.stringContaining('everport login'),
    });
    expect(byName(checks, 'relay')).toMatchObject({ ok: false });
    expect(byName(checks, 'agent')).toMatchObject({ ok: true });
    expect(checks.length).toBeGreaterThanOrEqual(9);
  });

  it('survives a wrangler that cannot run', async () => {
    const { everport, cloud } = setup();
    cloud.failCommand = { prefix: ['--version'], text: 'npx is missing' };
    const checks = await everport.doctor();
    expect(byName(checks, 'wrangler')).toMatchObject({ ok: false, detail: expect.stringContaining('npx is missing') });
    expect(byName(checks, 'node').ok).toBe(true);
  });

  it('tells a missing preview, another Worker at the address, and a network that is down apart', async () => {
    const { everport, cloud } = await withTunnels('fe', 'be', 'cms');
    cloud.worker(WORKER)!.previews.delete('fe');
    cloud.shadowed.add('be-everport.example.workers.dev');
    let checks = await everport.doctor();
    expect(byName(checks, 'tunnel fe')).toMatchObject({ ok: false, hint: expect.stringContaining('everport up') });
    expect(byName(checks, 'tunnel be')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('not answered by your relay'),
    });
    expect(byName(checks, 'tunnel cms').ok).toBe(true);
    cloud.shadowed.clear();
    cloud.unreachable = true;
    checks = await everport.doctor();
    expect(byName(checks, 'tunnel cms')).toMatchObject({ ok: false, detail: expect.stringContaining('cannot reach') });
  });

  it('reports a Worker that is gone from the account', async () => {
    const { everport, cloud } = await withTunnels('fe');
    cloud.workers.delete(WORKER);
    expect(byName(await everport.doctor(), 'relay')).toMatchObject({
      ok: false,
      detail: expect.stringContaining('is gone'),
    });
  });

  it('reports a missing relay secret', async () => {
    const { everport, fs, layout } = await withTunnels('fe');
    await fs.remove(layout.relaySecretFile);
    expect(byName(await everport.doctor(), 'relay secret')).toMatchObject({ ok: false });
  });
});

describe('login', () => {
  it('passes through to the deployer', async () => {
    const { everport, cloud } = setup();
    cloud.loggedIn = false;
    expect(await everport.isLoggedIn({ fresh: true })).toBe(false);
    await everport.login();
    expect(await everport.isLoggedIn({ fresh: true })).toBe(true);
  });
});
