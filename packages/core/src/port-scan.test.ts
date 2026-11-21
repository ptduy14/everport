import { describe, expect, it } from 'vitest';
import { candidateTarget, scanPorts } from './port-scan.js';
import type { PortScanner } from './ports.js';

const fakeScanner = (over: Partial<PortScanner> = {}): PortScanner & { probed: string[] } => {
  const probed: string[] = [];
  return {
    probed,
    platform: 'linux',
    currentUser: () => '1000',
    listeners: async () => [
      { address: '0.0.0.0', port: 4000, pid: 10 },
      { address: '::1', port: 5173, pid: 11 },
      { address: '127.0.0.53', port: 53, pid: 0 },
      { address: '0.0.0.0', port: 8787, pid: 0 },
    ],
    processes: async () => [
      { pid: 10, ppid: 1, user: '1000', name: 'node', cmd: 'node server.js', cwd: '/home/me/ws/api' },
      { pid: 11, ppid: 1, user: '1000', name: 'node', cmd: 'node /home/me/ws/fe/node_modules/.bin/vite' },
    ],
    docker: async () => ({ '8787': { name: 'proxy-1', project: 'proxy' } }),
    probe: async (host, port) => {
      probed.push(`${host}:${port}`);
      return port === 4000 ? 200 : 0;
    },
    ...over,
  };
};

describe('scanPorts', () => {
  it('classifies, probes only shown candidates on their own address, and marks shared ports', async () => {
    const scanner = fakeScanner();
    const result = await scanPorts(scanner, { workspaceFolders: ['/home/me/ws'], sharedPorts: [4000] });
    expect(result.map((c) => [c.port, c.group])).toEqual([
      [4000, 'workspace'],
      [5173, 'workspace'],
      [8787, 'docker'],
      [53, 'hidden'],
    ]);
    expect(scanner.probed.sort()).toEqual(['127.0.0.1:4000', '127.0.0.1:8787', '::1:5173']);
    expect(result.find((c) => c.port === 4000)).toMatchObject({ http: 200, shared: true, project: 'api' });
    expect(result.find((c) => c.port === 5173)!.detail).toContain('no HTTP response');
    expect(result.find((c) => c.port === 8787)!.project).toBe('proxy-1');
  });

  it('passes listener pids to processes()', async () => {
    let asked: number[] = [];
    const scanner = fakeScanner({
      processes: async (pids) => {
        asked = pids;
        return [];
      },
    });
    await scanPorts(scanner, { workspaceFolders: [] });
    expect(asked.sort()).toEqual([0, 10, 11]);
  });
});

describe('candidateTarget', () => {
  it('uses the address the service listens on', () => {
    expect(candidateTarget({ address: '0.0.0.0', port: 3000 })).toBe('http://127.0.0.1:3000');
    expect(candidateTarget({ address: '::', port: 3000 })).toBe('http://127.0.0.1:3000');
    expect(candidateTarget({ address: '::1', port: 5173 })).toBe('http://[::1]:5173');
    expect(candidateTarget({ address: '192.168.1.5', port: 8080 })).toBe('http://192.168.1.5:8080');
  });
});
