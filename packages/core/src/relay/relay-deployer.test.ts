import { CODE_VERSION } from '@everport/relay';
import { describe, expect, it } from 'vitest';
import { nullLogger } from '../logger.js';
import { createLayout } from '../paths.js';
import { FakeCloudflare } from '../testing/fake-cloudflare.js';
import { FakeFs } from '../testing/fake-fs.js';
import { RelayDeployer } from './relay-deployer.js';

const SECRET = 'ab'.repeat(32);
const WORKER = 'everport';

function setup() {
  const fs = new FakeFs().seed('/bundle/worker.js', `// fake relay worker, code version ${CODE_VERSION}`);
  const layout = createLayout({ platform: 'linux', env: {}, home: '/h' }, '/data');
  const cloud = new FakeCloudflare(fs, 'linux');
  const clock = { now: 0 };
  let counter = 0;
  const deployer = new RelayDeployer({
    wrangler: cloud.wrangler,
    probe: cloud.probe,
    fs,
    layout,
    logger: nullLogger,
    workerFile: '/bundle/worker.js',
    randomHex: (bytes) => (++counter).toString(16).padStart(bytes * 2, '0'),
    sleep: async () => {},
    now: () => clock.now,
  });
  const newTunnel = (label = 'fe', taken: string[] = []) =>
    deployer.createTunnel({ workerName: WORKER, secret: SECRET, taken, label });
  const commands = () => cloud.calls.map((c) => c.args.slice(0, 2).join(' '));
  return { fs, layout, cloud, deployer, clock, newTunnel, commands };
}

describe('login', () => {
  it('reports whether wrangler is logged in', async () => {
    const { cloud, deployer } = setup();
    expect(await deployer.isLoggedIn()).toBe(true);
    cloud.loggedIn = false;
    expect(await deployer.isLoggedIn({ fresh: true })).toBe(false);
  });

  it('keeps the answer for ten minutes (asking wrangler takes seconds) and asks again after that or when told to', async () => {
    const { cloud, deployer, clock } = setup();
    const asked = () => cloud.calls.filter((c) => c.args[0] === 'whoami').length;
    await deployer.isLoggedIn();
    await deployer.isLoggedIn();
    expect(asked()).toBe(1);
    await deployer.isLoggedIn({ fresh: true });
    expect(asked()).toBe(2);
    clock.now = 10 * 60_000 + 1;
    await deployer.isLoggedIn();
    expect(asked()).toBe(3);
  });

  it('shares one wrangler run between callers at the same moment, so they do not race to refresh the token', async () => {
    const { cloud, deployer } = setup();
    expect(await Promise.all([deployer.isLoggedIn(), deployer.isLoggedIn({ fresh: true })])).toEqual([true, true]);
    expect(cloud.calls.filter((c) => c.args[0] === 'whoami')).toHaveLength(1);
  });

  it('asks again once when another run won the token refresh, and says logged out when the token is still gone', async () => {
    const { cloud, deployer } = setup();
    cloud.failCommand = { prefix: ['whoami'], text: 'No API token found.', times: 1 };
    expect(await deployer.isLoggedIn()).toBe(true);
    expect(cloud.calls.filter((c) => c.args[0] === 'whoami')).toHaveLength(2);

    cloud.failCommand = { prefix: ['whoami'], text: 'No API token found.' };
    expect(await deployer.isLoggedIn({ fresh: true })).toBe(false);
  });

  it('retries any command that lost the token refresh, and calls a lasting loss NOT_LOGGED_IN', async () => {
    const { cloud, newTunnel } = setup();
    cloud.failCommand = { prefix: ['versions', 'list'], text: 'No API token found.', times: 1 };
    await expect(newTunnel('fe')).resolves.toMatchObject({ name: 'fe' });

    cloud.failCommand = { prefix: ['versions', 'list'], text: 'No API token found.' };
    await expect(newTunnel('be')).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });

  it('runs `wrangler login` interactively, and checks it worked', async () => {
    const { cloud, deployer } = setup();
    cloud.loggedIn = false;
    await deployer.login();
    const login = cloud.calls.find((c) => c.args[0] === 'login')!;
    expect(login.interactive).toBe(true);
    expect(await deployer.isLoggedIn()).toBe(true);
  });

  it('says NOT_LOGGED_IN when the login does not finish', async () => {
    const { cloud, deployer } = setup();
    cloud.loggedIn = false;
    cloud.loginSucceeds = false;
    await expect(deployer.login()).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });

  it('says CANCELLED, not a failed login, when the person stops it', async () => {
    const { cloud, deployer } = setup();
    cloud.loggedIn = false;
    const stop = new AbortController();
    stop.abort();
    await expect(deployer.login(stop.signal)).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(cloud.loggedIn).toBe(false);
  });
});

describe('probeWorker', () => {
  it('tells a missing Worker, a Worker with only previews, and a regular Worker apart', async () => {
    const { cloud, deployer, newTunnel } = setup();
    expect(await deployer.probeWorker(WORKER)).toBe('none');
    await newTunnel();
    expect(await deployer.probeWorker(WORKER)).toBe('previews-only');
    cloud.workers.set('someone-elses', { regular: true, previews: new Map() });
    expect(await deployer.probeWorker('someone-elses')).toBe('regular');
  });
});

describe('createTunnel', () => {
  it('writes the config and the Worker, deploys one preview with the secret in a private file, and verifies it', async () => {
    const { cloud, fs, layout, newTunnel, commands } = setup();
    const created = await newTunnel('Backend API');

    expect(created).toEqual({
      id: expect.any(String),
      label: 'Backend API',
      name: 'backend-api',
      url: 'https://backend-api-everport.example.workers.dev',
      subdomain: 'example',
      codeVersion: CODE_VERSION,
    });
    expect(commands()).toEqual(['versions list', 'preview secret', 'preview --name']);

    const dir = '/data/relay';
    expect(fs.text(`${dir}/wrangler.toml`)).toContain('name = "everport"');
    expect(fs.text(`${dir}/worker.js`)).toBe(`// fake relay worker, code version ${CODE_VERSION}`);

    const deploy = cloud.calls[2]!;
    expect(deploy.cwd).toBe(dir);
    expect(deploy.args).toEqual(
      expect.arrayContaining([
        '--name',
        'backend-api',
        '--worker-name',
        WORKER,
        '--var',
        'TUNNEL:backend-api',
        '--json',
      ]),
    );
    const secretsFile = deploy.args[deploy.args.indexOf('--secrets-file') + 1]!;
    expect(secretsFile.startsWith(`${dir}/secrets-`)).toBe(true);
    expect(await fs.exists(secretsFile)).toBe(false); // gone once wrangler is done with it
    expect(fs.privatePaths.has(secretsFile)).toBe(true); // and it was written for the owner only
    expect(cloud.preview(WORKER, 'backend-api')!.secret).toBe(SECRET);
    expect(layout.platform).toBe('linux');
  });

  it('turns the label into a name Cloudflare accepts, keeping the label as typed', async () => {
    const { newTunnel } = setup();
    expect(await newTunnel('Café API')).toMatchObject({ label: 'Café API', name: 'cafe-api' });
  });

  it('refuses a name another tunnel already has, before touching Cloudflare', async () => {
    const { newTunnel, cloud } = setup();
    await expect(newTunnel('FE', ['fe'])).rejects.toMatchObject({ code: 'TUNNEL_EXISTS' });
    expect(cloud.calls).toHaveLength(0);
  });

  it('never touches a Worker that is not its own', async () => {
    const { cloud, deployer, commands } = setup();
    cloud.workers.set(WORKER, { regular: true, previews: new Map() });
    await expect(
      deployer.createTunnel({ workerName: WORKER, secret: SECRET, taken: [], label: 'fe' }),
    ).rejects.toMatchObject({
      code: 'WORKER_NAME_TAKEN',
    });
    expect(commands()).not.toContain('preview --name');
  });

  it('refuses a name already on Cloudflare (another computer on the same account), and leaves that preview alone', async () => {
    const { cloud, deployer, newTunnel, commands } = setup();
    await newTunnel('fe'); // made elsewhere: not in this computer's list
    const before = cloud.preview(WORKER, 'fe')!;
    cloud.calls.length = 0;
    await expect(
      deployer.createTunnel({ workerName: WORKER, secret: 'cd'.repeat(32), taken: [], label: 'fe' }),
    ).rejects.toMatchObject({ code: 'TUNNEL_EXISTS' });
    expect(commands()).not.toContain('preview --name');
    expect(commands()).not.toContain('preview delete');
    expect(cloud.preview(WORKER, 'fe')).toBe(before);
    expect(cloud.preview(WORKER, 'fe')!.secret).toBe(SECRET);
  });

  it('adds a preview to a Worker that has only previews', async () => {
    const { cloud, newTunnel } = setup();
    await newTunnel('fe');
    await newTunnel('be');
    expect([...cloud.worker(WORKER)!.previews.keys()].sort()).toEqual(['be', 'fe']);
  });

  it('says NOT_LOGGED_IN when wrangler is logged out', async () => {
    const { cloud, newTunnel } = setup();
    cloud.loggedIn = false;
    await expect(newTunnel()).rejects.toMatchObject({ code: 'NOT_LOGGED_IN' });
  });

  it('reports what wrangler said when it fails, and does not leave the secrets file behind', async () => {
    const { cloud, fs, newTunnel } = setup();
    cloud.failCommand = { prefix: ['preview', '--name'], text: 'the Cloudflare API is down' };
    await expect(newTunnel()).rejects.toMatchObject({
      code: 'WRANGLER_FAILED',
      message: expect.stringContaining('the Cloudflare API is down'),
    });
    expect([...fs.files.keys()].filter((p) => p.includes('secrets-'))).toEqual([]);
  });

  it('redeploys with the slug Cloudflare chose when it differs from the name, so the token matches', async () => {
    const { cloud, newTunnel } = setup();
    cloud.slugFor = (name) => `${name}-x`;
    const created = await newTunnel('fe');
    expect(created.name).toBe('fe-x');
    expect(cloud.preview(WORKER, 'fe')!.vars['TUNNEL']).toBe('fe-x');
    expect(created.url).toContain('fe-x-everport');
  });
});

describe('createTunnel: checking the result', () => {
  it('waits for a new preview to spread (it can answer 404 for a moment)', async () => {
    const { cloud, newTunnel } = setup();
    cloud.notReadyVersionProbes = 2;
    cloud.notReadyHandshakes = 1;
    await expect(newTunnel()).resolves.toMatchObject({ name: 'fe' });
  });

  it('gives up, and removes the preview, when it never answers as the relay', async () => {
    const { cloud, newTunnel } = setup();
    cloud.notReadyVersionProbes = 99;
    await expect(newTunnel()).rejects.toMatchObject({ code: 'RELAY_MISMATCH' });
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
  });

  it('does not send a token to a stranger who answers at the same address, and removes the preview', async () => {
    const { cloud, newTunnel } = setup();
    cloud.shadowed.add('fe-everport.example.workers.dev');
    await expect(newTunnel('fe')).rejects.toMatchObject({ code: 'RELAY_MISMATCH' });
    expect(cloud.handshakes).toEqual([]);
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
  });

  it('notices a relay that stored a different secret from the one it was given, and removes the preview', async () => {
    const { cloud, newTunnel } = setup();
    cloud.corruptStoredSecret = true;
    await expect(newTunnel()).rejects.toMatchObject({
      code: 'WRANGLER_FAILED',
      message: expect.stringContaining('rejected the secret'),
    });
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
  });

  it('says so when the new tunnel cannot be reached at all', async () => {
    const { cloud, newTunnel } = setup();
    cloud.unreachable = true;
    await expect(newTunnel()).rejects.toMatchObject({
      code: 'WRANGLER_FAILED',
      message: expect.stringContaining('does not answer'),
    });
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
  });
});

describe('createTunnels', () => {
  const labels = ['fe', 'be', 'cms'];

  it('creates the first preview of a new Worker alone, then the rest together (three at once fail with 10040)', async () => {
    const { cloud, deployer, commands } = setup();
    const created = await deployer.createTunnels({ workerName: WORKER, secret: SECRET, taken: [], labels });
    expect(created.map((c) => c.name)).toEqual(labels);
    expect(commands().filter((c) => c === 'versions list')).toHaveLength(1);

    const deploys = cloud.calls.filter((c) => c.args[0] === 'preview' && c.args[1] === '--name');
    expect(deploys).toHaveLength(3);
    const [first, second, third] = deploys as [(typeof deploys)[0], (typeof deploys)[0], (typeof deploys)[0]];
    expect(first.finishedAt).toBeLessThanOrEqual(second.startedAt);
    expect(first.finishedAt).toBeLessThanOrEqual(third.startedAt);
    expect(second.startedAt).toBeLessThan(third.finishedAt!); // the other two did overlap
  });

  it('creates every preview together on a Worker that already exists', async () => {
    const { cloud, deployer, newTunnel } = setup();
    await newTunnel('first');
    cloud.calls.length = 0;
    await deployer.createTunnels({ workerName: WORKER, secret: SECRET, taken: ['first'], labels });
    const deploys = cloud.calls.filter((c) => c.args[0] === 'preview' && c.args[1] === '--name');
    expect(deploys[1]!.startedAt).toBeLessThan(deploys[0]!.finishedAt!);
  });

  it('refuses two labels that become the same name, before touching Cloudflare', async () => {
    const { cloud, deployer } = setup();
    await expect(
      deployer.createTunnels({ workerName: WORKER, secret: SECRET, taken: [], labels: ['My App', 'my-app'] }),
    ).rejects.toMatchObject({
      code: 'TUNNEL_EXISTS',
    });
    expect(cloud.calls).toHaveLength(0);
  });

  it('is all or nothing: when one fails, the ones that were made are removed again', async () => {
    const { cloud, deployer, newTunnel } = setup();
    await newTunnel('first');
    await deployer.removeTunnel(WORKER, 'first'); // leaves a Worker with no previews
    cloud.failCommand = { prefix: ['preview', '--name'], text: 'boom', skip: 1 };
    await expect(
      deployer.createTunnels({ workerName: WORKER, secret: SECRET, taken: [], labels: ['a', 'b'] }),
    ).rejects.toMatchObject({
      code: 'WRANGLER_FAILED',
    });
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
  });
});

describe('recreateTunnel', () => {
  it('brings back a preview that went missing under the same name, so with the same URL', async () => {
    const { cloud, deployer, newTunnel } = setup();
    const created = await newTunnel('fe');
    cloud.worker(WORKER)!.previews.delete('fe'); // Cloudflare lost it
    expect(await deployer.previewExists(WORKER, 'fe')).toBe(false);

    const back = await deployer.recreateTunnel({ workerName: WORKER, name: 'fe', secret: SECRET });
    expect(back.url).toBe(created.url);
    expect(await deployer.previewExists(WORKER, 'fe')).toBe(true);
  });

  it('is also how an existing preview gets new relay code', async () => {
    const { cloud, fs, deployer, newTunnel } = setup();
    const created = await newTunnel('fe');
    expect((await deployer.checkTunnel(created.url, 'fe')).codeVersion).toBe(CODE_VERSION);

    fs.seed('/bundle/worker.js', '// fake relay worker, code version 99');
    await deployer.recreateTunnel({ workerName: WORKER, name: 'fe', secret: SECRET });
    expect(cloud.preview(WORKER, 'fe')!.codeVersion).toBe('99');
    expect((await deployer.checkTunnel(created.url, 'fe')).codeVersion).toBe('99');
  });

  it('never adds a preview to a Worker that has become an ordinary one', async () => {
    const { cloud, deployer, newTunnel } = setup();
    await newTunnel('fe');
    cloud.worker(WORKER)!.previews.delete('fe');
    cloud.worker(WORKER)!.regular = true; // someone deployed their own code under that name
    await expect(deployer.recreateTunnel({ workerName: WORKER, name: 'fe', secret: SECRET })).rejects.toMatchObject({
      code: 'WORKER_NAME_TAKEN',
    });
    expect(cloud.preview(WORKER, 'fe')).toBeUndefined();
  });
});

describe('removing', () => {
  it('removes a preview, and counts one that is already gone as removed', async () => {
    const { cloud, deployer, newTunnel } = setup();
    await newTunnel('fe');
    await deployer.removeTunnel(WORKER, 'fe');
    expect(cloud.worker(WORKER)!.previews.size).toBe(0);
    await expect(deployer.removeTunnel(WORKER, 'fe')).resolves.toBeUndefined();
  });

  it('does not hide a real failure', async () => {
    const { cloud, deployer, newTunnel } = setup();
    await newTunnel('fe');
    cloud.failCommand = { prefix: ['preview', 'delete'], text: 'the Cloudflare API is down' };
    await expect(deployer.removeTunnel(WORKER, 'fe')).rejects.toMatchObject({ code: 'WRANGLER_FAILED' });
  });

  it('removes the whole Worker only when asked, and is fine with one that is gone', async () => {
    const { cloud, deployer, newTunnel } = setup();
    await newTunnel('fe');
    await deployer.deleteRelay(WORKER);
    expect(cloud.worker(WORKER)).toBeUndefined();
    await expect(deployer.deleteRelay(WORKER)).resolves.toBeUndefined();
  });
});

describe('checking a tunnel without disturbing it', () => {
  it('says ok, and asks /__ep/version only: a handshake would push the running agent out', async () => {
    const { cloud, deployer, newTunnel } = setup();
    const created = await newTunnel('fe');
    const handshakesBefore = cloud.handshakes.length;
    expect(await deployer.checkTunnel(created.url, 'fe')).toEqual({ health: 'ok', codeVersion: CODE_VERSION });
    expect(cloud.handshakes).toHaveLength(handshakesBefore);
  });

  it('tells apart a preview that is gone, one answered by something else, a relay of another tunnel, and no answer', async () => {
    const { cloud, deployer, newTunnel } = setup();
    const created = await newTunnel('fe');
    expect((await deployer.checkTunnel(created.url, 'be')).health).toBe('mismatch');
    cloud.shadowed.add(new URL(created.url).hostname);
    expect((await deployer.checkTunnel(created.url, 'fe')).health).toBe('mismatch');
    cloud.shadowed.clear();
    cloud.worker(WORKER)!.previews.delete('fe');
    expect((await deployer.checkTunnel(created.url, 'fe')).health).toBe('not-found');
    cloud.unreachable = true;
    expect((await deployer.checkTunnel(created.url, 'fe')).health).toBe('unreachable');
  });
});
