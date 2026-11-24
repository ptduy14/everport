import { EverportError, type DoctorCheck, type StopOutcome, type TunnelStatus } from '@everport/core';
import { describe, expect, it, vi } from 'vitest';
import { run, type CliContext, type Manager } from './program.js';

const URL_OF_BACKEND = 'https://backend-api-everport.example.workers.dev';

const status = (over: Partial<TunnelStatus> = {}): TunnelStatus => ({
  id: 'b3f1c2',
  label: 'Backend API',
  name: 'backend-api',
  url: URL_OF_BACKEND,
  target: 'http://127.0.0.1:3301',
  enabled: true,
  state: 'active',
  ...over,
});

function setup(overrides: Partial<Record<keyof Manager, unknown>> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const base = {
    up: vi.fn(async () => [status()]),
    down: vi.fn(async (): Promise<StopOutcome> => 'stopped'),
    add: vi.fn(async () => status()),
    remove: vi.fn(async () => {}),
    start: vi.fn(async () => status()),
    stop: vi.fn(async () => status({ enabled: false, state: 'stopped' })),
    status: vi.fn(async () => [status()]),
    doctor: vi.fn(async (): Promise<DoctorCheck[]> => [{ name: 'wrangler', ok: true, detail: 'wrangler 4.166.0' }]),
    login: vi.fn(async () => {}),
    isLoggedIn: vi.fn(async () => false),
    on: vi.fn(() => () => {}),
  };
  const manager = { ...base, ...overrides } as typeof base;
  const ctx: CliContext = {
    version: '1.2.3',
    wranglerVersion: '4.166.0',
    createManager: async () => manager as unknown as Manager,
    out: (l) => out.push(l),
    err: (l) => err.push(l),
    copy: vi.fn(async () => {}),
  };
  const go = (...argv: string[]) => run(argv, ctx);
  return { manager, ctx, out, err, go, text: () => out.join('\n'), errText: () => err.join('\n') };
}

describe('help and version', () => {
  it('--version prints the Everport and wrangler versions', async () => {
    const s = setup();
    expect(await s.go('--version')).toBe(0);
    expect(s.text()).toBe('everport 1.2.3 (wrangler 4.166.0)');
  });

  it('--help and no arguments list the commands without creating a manager', async () => {
    const s = setup();
    const create = vi.fn(s.ctx.createManager);
    s.ctx.createManager = create;
    expect(await s.go('--help')).toBe(0);
    expect(await s.go()).toBe(0);
    for (const command of ['login', 'add', 'up', 'down', 'ls', 'rm', 'doctor']) expect(s.text()).toContain(command);
    expect(create).not.toHaveBeenCalled();
  });

  it('an unknown command is a usage error (exit 2)', async () => {
    const s = setup();
    expect(await s.go('frobnicate')).toBe(2);
    expect(s.errText()).toContain('unknown command');
  });

  it('options from the zrok days are gone: --name and --release-name are usage errors', async () => {
    const s = setup();
    expect(await s.go('add', '3000', '--name', 'x')).toBe(2);
    expect(await s.go('rm', 'API', '--release-name')).toBe(2);
    expect(s.manager.add).not.toHaveBeenCalled();
    expect(s.manager.remove).not.toHaveBeenCalled();
  });
});

describe('login', () => {
  it('logs in through the browser when not logged in, and says so', async () => {
    const s = setup();
    expect(await s.go('login')).toBe(0);
    expect(s.manager.login).toHaveBeenCalledTimes(1);
    expect(s.text()).toBe('Logged in to Cloudflare.');
    expect(s.errText()).toContain('Opening your browser');
  });

  it('does not open the browser when already logged in', async () => {
    const s = setup({ isLoggedIn: vi.fn(async () => true) });
    expect(await s.go('login')).toBe(0);
    expect(s.manager.login).not.toHaveBeenCalled();
    expect(s.text()).toBe('Already logged in to Cloudflare.');
  });

  it('asks for a fresh answer, since a stale "logged in" would be wrong', async () => {
    const s = setup();
    await s.go('login');
    expect(s.manager.isLoggedIn).toHaveBeenCalledWith({ fresh: true });
  });

  it('warns that the first run can take a minute (wrangler is downloaded)', async () => {
    const s = setup();
    await s.go('login');
    expect(s.errText()).toContain('can take a minute');
  });

  it('shows the failure and exits 1 when the login does not finish', async () => {
    const s = setup({
      login: vi.fn(async () => {
        throw new EverportError('NOT_LOGGED_IN', 'The Cloudflare login did not finish', 'Run "everport login" again.');
      }),
    });
    expect(await s.go('login')).toBe(1);
    expect(s.errText()).toContain('did not finish');
    expect(s.errText()).toContain('Fix: run "everport login" again.');
  });
});

describe('add', () => {
  it('passes the target and label, and prints the URL first', async () => {
    const s = setup();
    expect(await s.go('add', '3000', '--label', 'API')).toBe(0);
    expect(s.manager.add).toHaveBeenCalledWith({ target: '3000', label: 'API' });
    expect(s.out[0]).toBe(URL_OF_BACKEND);
  });

  it('passes no label when none was given', async () => {
    const s = setup();
    await s.go('add', '3000');
    expect(s.manager.add).toHaveBeenCalledWith({ target: '3000' });
  });

  it('after the very first tunnel, says that the address holds the workers.dev subdomain', async () => {
    const s = setup({ status: vi.fn(async () => []) });
    await s.go('add', '3000');
    expect(s.errText()).toContain('workers.dev subdomain ("example")');
    expect(s.errText()).toContain('taken from your email');
  });

  it('does not repeat that note for later tunnels', async () => {
    const s = setup();
    await s.go('add', '3000');
    expect(s.errText()).not.toContain('workers.dev subdomain');
  });

  it('--copy copies the URL, and a clipboard failure only warns', async () => {
    const s = setup();
    await s.go('add', '3000', '--copy');
    expect(s.ctx.copy).toHaveBeenCalledWith(URL_OF_BACKEND);

    const s2 = setup();
    s2.ctx.copy = async () => {
      throw new Error('no clip');
    };
    expect(await s2.go('add', '3000', '--copy')).toBe(0);
    expect(s2.errText()).toContain('Could not copy: no clip');
  });

  it('tells the user to run "everport up" when the agent is down', async () => {
    const s = setup({ add: vi.fn(async () => status({ state: 'down' })) });
    await s.go('add', '3000');
    expect(s.errText()).toContain('everport up');
  });

  it('exits 1 and explains when the tunnel was saved but could not be served', async () => {
    const s = setup({
      add: vi.fn(async () =>
        status({
          state: 'failed',
          error: { code: 'AGENT_NOT_RUNNING', message: 'The agent exited', hint: 'See the log.' },
        }),
      ),
    });
    expect(await s.go('add', '3000')).toBe(1);
    expect(s.errText()).toContain('The agent exited');
    expect(s.errText()).toContain('Fix: see the log.');
  });

  it('reports a refusal with its hint, exit 1, for example when not logged in', async () => {
    const s = setup({
      add: vi.fn(async () => {
        throw new EverportError('NOT_LOGGED_IN', 'You are not logged in to Cloudflare', 'Run "everport login".');
      }),
    });
    expect(await s.go('add', '3000')).toBe(1);
    expect(s.errText()).toContain('Error: You are not logged in to Cloudflare');
    expect(s.errText()).toContain('Fix: run "everport login".');
  });
});

describe('up and down', () => {
  it('up prints the tunnel table and streams events to stderr', async () => {
    const s = setup();
    s.manager.on.mockImplementation(((_e: string, l: (e: { message: string }) => void) => {
      l({ message: 'Starting the agent' });
      return () => {};
    }) as never);
    expect(await s.go('up')).toBe(0);
    expect(s.text()).toContain(URL_OF_BACKEND);
    expect(s.errText()).toContain('Starting the agent');
  });

  it('up exits 1 and explains a failed tunnel with its fix', async () => {
    const s = setup({
      up: vi.fn(async () => [
        status({
          state: 'failed',
          error: { code: 'RELAY_MISMATCH', message: 'not your relay', hint: 'pick another label' },
        }),
      ]),
    });
    expect(await s.go('up')).toBe(1);
    expect(s.errText()).toContain('! Backend API: not your relay');
    expect(s.errText()).toContain('pick another label');
  });

  it('up --json prints only JSON on stdout', async () => {
    const s = setup();
    await s.go('up', '--json');
    expect(JSON.parse(s.text())[0].name).toBe('backend-api');
  });

  it.each([
    ['stopped', 'keep their addresses'],
    ['killed', 'was killed'],
    ['not-running', 'Nothing to stop'],
  ] as const)('down tells the truth when the outcome is %s', async (outcome, text) => {
    const s = setup();
    s.manager.down.mockResolvedValueOnce(outcome);
    expect(await s.go('down')).toBe(0);
    expect(s.text()).toContain(text);
  });

  it('reports unexpected errors without a stack by default, and with one under EVERPORT_DEBUG', async () => {
    const boom = vi.fn(async () => {
      throw new Error('kaput');
    });
    const quiet = setup({ down: boom });
    expect(await quiet.go('down')).toBe(1);
    expect(quiet.errText()).toBe('Unexpected error: kaput');

    const loud = setup({ down: boom });
    loud.ctx.debug = true;
    await loud.go('down');
    expect(loud.errText()).toContain('Unexpected error: kaput');
    expect(loud.errText()).toContain('at ');
  });
});

describe('ls, start, stop, rm, copy', () => {
  it('ls shows the table, status is an alias, --json is valid JSON', async () => {
    const s = setup();
    await s.go('ls');
    await s.go('status', '--json');
    expect(s.out[0]).toContain('LABEL');
    expect(s.manager.status).toHaveBeenCalledTimes(2);
    expect(JSON.parse(s.out.slice(1).join('\n'))).toHaveLength(1);
  });

  it('ls on an empty setup points at "everport add"', async () => {
    const s = setup({ status: vi.fn(async () => []) });
    await s.go('ls');
    expect(s.text()).toContain('everport add');
  });

  it('ls --health asks for health and explains a preview that is gone', async () => {
    const s = setup({ status: vi.fn(async () => [status({ state: 'missing', health: 'not-found' })]) });
    await s.go('ls', '--health');
    expect(s.manager.status).toHaveBeenCalledWith({ health: true });
    expect(s.text()).toContain('HEALTH');
    expect(s.text()).toContain('missing');
    expect(s.errText()).toContain('everport up');
  });

  it('ls --health mentions relay code that is older than this Everport', async () => {
    const s = setup({ status: vi.fn(async () => [status({ health: 'ok', outdated: true })]) });
    await s.go('ls', '--health');
    expect(s.errText()).toContain('from an older Everport');
  });

  it('start and stop forward the id or label', async () => {
    const s = setup();
    await s.go('start', 'API');
    await s.go('stop', 'b3f1c2');
    expect(s.manager.start).toHaveBeenCalledWith('API');
    expect(s.manager.stop).toHaveBeenCalledWith('b3f1c2');
  });

  it('start tells the user to run "everport up" when the agent is down', async () => {
    const s = setup({ start: vi.fn(async () => status({ state: 'down' })) });
    await s.go('start', 'API');
    expect(s.errText()).toContain('everport up');
  });

  it('rm forwards the id or label, and says the address stops working', async () => {
    const s = setup();
    await s.go('rm', 'API');
    await s.go('remove', 'b3f1c2');
    expect(s.manager.remove).toHaveBeenNthCalledWith(1, 'API');
    expect(s.manager.remove).toHaveBeenNthCalledWith(2, 'b3f1c2');
    expect(s.text()).toContain('no longer works');
  });

  it('copy finds a tunnel by label (any case) or id', async () => {
    const s = setup();
    expect(await s.go('copy', 'backend api')).toBe(0);
    expect(await s.go('copy', 'b3f1c2')).toBe(0);
    expect(s.ctx.copy).toHaveBeenCalledTimes(2);
  });

  it('copy of an unknown tunnel fails with exit 1', async () => {
    const s = setup();
    expect(await s.go('copy', 'nope')).toBe(1);
    expect(s.errText()).toContain('No tunnel');
  });
});

describe('doctor', () => {
  it('prints each check; exit 0 when all pass', async () => {
    const s = setup();
    expect(await s.go('doctor')).toBe(0);
    expect(s.text()).toContain('OK    wrangler: wrangler 4.166.0');
  });

  it('exits 1 with the hint under each failed check', async () => {
    const s = setup({
      doctor: vi.fn(async (): Promise<DoctorCheck[]> => [
        { name: 'cloudflare login', ok: false, detail: 'not logged in', hint: 'Run "everport login".' },
      ]),
    });
    expect(await s.go('doctor')).toBe(1);
    expect(s.text()).toContain('FAIL  cloudflare login: not logged in');
    expect(s.text()).toContain('Fix: run "everport login".');
  });

  it('--json prints the checks as JSON', async () => {
    const s = setup();
    await s.go('doctor', '--json');
    expect(JSON.parse(s.text())[0]).toMatchObject({ name: 'wrangler', ok: true });
  });
});
