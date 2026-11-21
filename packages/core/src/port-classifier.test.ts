import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { classifyPorts, type PortGroup, type PortSnapshot } from './port-classifier.js';

type Expected = Record<PortGroup, number[]> & { labels: Record<string, string> };
const expectedAll = JSON.parse(
  readFileSync(new URL('./testing/fixtures/ports/expected.json', import.meta.url), 'utf8'),
) as Record<string, Expected>;

describe('classifyPorts fixtures', () => {
  for (const f of ['windows', 'linux-wsl', 'ubuntu', 'macos']) {
    it(`matches expected groups and labels for ${f}`, () => {
      const snap = JSON.parse(
        readFileSync(new URL(`./testing/fixtures/ports/${f}.json`, import.meta.url), 'utf8'),
      ) as PortSnapshot;
      const exp = expectedAll[f]!;
      const result = classifyPorts(snap);
      for (const group of ['workspace', 'docker', 'dev', 'other', 'hidden'] as const) {
        expect(
          result.filter((c) => c.group === group).map((c) => c.port),
          `${f}: ${group}`,
        ).toEqual(exp[group]);
      }
      for (const [port, text] of Object.entries(exp.labels)) {
        expect(result.find((c) => c.port === Number(port))?.label).toContain(text);
      }
    });
  }
});

const base = (over: Partial<PortSnapshot> = {}): PortSnapshot => ({
  platform: 'linux',
  currentUser: 'me',
  workspaceFolders: ['/home/me/ws'],
  listeners: [],
  processes: [],
  docker: {},
  http: {},
  ...over,
});

const node = (pid: number, cwd: string, extra: object = {}) => ({
  pid,
  ppid: 1,
  name: 'node',
  cmd: 'node server.js',
  user: 'me',
  cwd,
  ...extra,
});

describe('classifyPorts rules', () => {
  it('prefers 0.0.0.0, then ::, then the first listener', () => {
    const mk = (addrs: string[]) =>
      classifyPorts(
        base({
          listeners: addrs.map((address) => ({ address, port: 3000, pid: 10 })),
          processes: [node(10, '/x')],
        }),
      )[0]!.address;
    expect(mk(['127.0.0.1', '::', '0.0.0.0'])).toBe('0.0.0.0');
    expect(mk(['127.0.0.1', '::'])).toBe('::');
    expect(mk(['127.0.0.1', '10.0.0.1'])).toBe('127.0.0.1');
  });

  it('flags shared ports', () => {
    const snap = base({ listeners: [{ address: '0.0.0.0', port: 3000, pid: 10 }], processes: [node(10, '/x')] });
    const [c] = classifyPorts(snap, { sharedPorts: [3000] });
    expect(c!.shared).toBe(true);
    expect(c!.detail).toContain('already shared');
    expect(classifyPorts(snap)[0]!.shared).toBe(false);
  });

  it('tags missing or zero HTTP responses, not answered ones', () => {
    const l = [{ address: '0.0.0.0', port: 3000, pid: 10 }];
    const procs = [node(10, '/x')];
    expect(classifyPorts(base({ listeners: l, processes: procs }))[0]!.detail).toContain('no HTTP response');
    expect(classifyPorts(base({ listeners: l, processes: procs, http: { '3000': 0 } }))[0]!.detail).toContain(
      'no HTTP response',
    );
    const ok = classifyPorts(base({ listeners: l, processes: procs, http: { '3000': 200 } }))[0]!;
    expect(ok.detail).not.toContain('no HTTP response');
    expect(ok.http).toBe(200);
  });

  it('matches workspace folders case-insensitively on win32', () => {
    const snap = base({
      platform: 'win32',
      currentUser: 'PC',
      workspaceFolders: ['D:\\Work\\API'],
      listeners: [{ address: '0.0.0.0', port: 3301, pid: 10 }],
      processes: [{ pid: 10, ppid: 1, name: 'node.exe', cmd: 'node.exe x.js', cwd: 'd:/work/api/server' }],
    });
    const [c] = classifyPorts(snap);
    expect(c!.group).toBe('workspace');
    expect(c!.detail).toBe('dev runtime node.exe; project server; in this workspace; no HTTP response');
  });

  it('does not treat a sibling folder with the same prefix as inside', () => {
    const snap = base({
      listeners: [{ address: '0.0.0.0', port: 3000, pid: 10 }],
      processes: [node(10, '/home/me/ws-other')],
    });
    expect(classifyPorts(snap)[0]!.group).toBe('dev');
  });

  it("hides another user's process on linux, but keeps databases as other", () => {
    const snap = base({
      listeners: [
        { address: '0.0.0.0', port: 80, pid: 20 },
        { address: '0.0.0.0', port: 6379, pid: 21 },
      ],
      processes: [
        { pid: 20, ppid: 1, name: 'node', cmd: 'node', user: 'root' },
        { pid: 21, ppid: 1, name: 'redis-server', cmd: 'redis-server', user: 'redis' },
      ],
    });
    const r = classifyPorts(snap);
    expect(r.find((c) => c.port === 80)!.group).toBe('hidden');
    expect(r.find((c) => c.port === 6379)!.group).toBe('other');
  });

  it('matches the executable when the name does not match (redis-server symlink)', () => {
    const snap = base({
      listeners: [{ address: '0.0.0.0', port: 6379, pid: 21 }],
      processes: [{ pid: 21, ppid: 1, name: '*:6379', exe: 'redis-server', cmd: '*:6379', user: 'me' }],
    });
    const [c] = classifyPorts(snap);
    expect(c!.group).toBe('other');
    expect(c!.label).toBe('*:6379');
  });

  it('puts docker ports in docker, or workspace when the compose dir is inside it', () => {
    const snap = base({
      listeners: [
        { address: '0.0.0.0', port: 8787, pid: 0 },
        { address: '0.0.0.0', port: 9000, pid: 0 },
      ],
      docker: {
        '8787': { name: 'proxy', project: 'stack', dir: '/srv/stack' },
        '9000': { name: 'db', dir: '/home/me/ws/infra' },
      },
    });
    const r = classifyPorts(snap);
    expect(r.find((c) => c.port === 8787)).toMatchObject({ group: 'docker', label: 'proxy (stack)' });
    expect(r.find((c) => c.port === 9000)).toMatchObject({ group: 'workspace', label: 'db' });
  });

  it('labels wslrelay on win32 and sorts by group then port', () => {
    const snap = base({
      platform: 'win32',
      currentUser: 'PC',
      listeners: [
        { address: '0.0.0.0', port: 6379, pid: 30 },
        { address: '0.0.0.0', port: 3000, pid: 31 },
        { address: '0.0.0.0', port: 135, pid: 4 },
      ],
      processes: [
        { pid: 30, ppid: 1, name: 'wslrelay.exe', cmd: 'wslrelay.exe' },
        { pid: 31, ppid: 1, name: 'node.exe', cmd: 'node.exe a.js', cwd: 'C:\\other' },
      ],
    });
    const r = classifyPorts(snap);
    expect(r.map((c) => [c.port, c.group])).toEqual([
      [3000, 'dev'],
      [6379, 'other'],
      [135, 'hidden'],
    ]);
    expect(r[1]!.label).toBe('forwarded from WSL');
  });

  it('hides Windows services unless they are databases or dev runtimes', () => {
    const procs = [
      { pid: 1, ppid: 0, name: 'services.exe', cmd: '' },
      { pid: 40, ppid: 1, name: 'foo.exe', cmd: 'foo.exe' },
      { pid: 41, ppid: 1, name: 'postgres.exe', cmd: 'postgres.exe' },
    ];
    const snap = base({
      platform: 'win32',
      currentUser: 'PC',
      listeners: [
        { address: '0.0.0.0', port: 7680, pid: 40 },
        { address: '0.0.0.0', port: 5432, pid: 41 },
      ],
      processes: procs,
    });
    const r = classifyPorts(snap);
    expect(r.find((c) => c.port === 7680)!.group).toBe('hidden');
    expect(r.find((c) => c.port === 5432)!.group).toBe('other');
  });

  it('does not take the project name from the runtime install path', () => {
    const snap = base({
      listeners: [
        { address: '0.0.0.0', port: 4000, pid: 10 },
        { address: '0.0.0.0', port: 3000, pid: 11 },
      ],
      processes: [
        node(10, '/home/me/ws/api', { cmd: '/home/me/.local/node/bin/node server.js' }),
        {
          pid: 11,
          ppid: 1,
          name: 'node.exe',
          cmd: String.raw`"C:\Program Files\nodejs\node.exe" D:\x\fe-app\node_modules\vite\bin\vite.js`,
          user: 'me',
        },
      ],
    });
    const r = classifyPorts(snap);
    expect(r.find((c) => c.port === 4000)!.project).toBe('api');
    expect(r.find((c) => c.port === 3000)!.project).toBe('fe-app');
  });
});
