import { describe, expect, it } from 'vitest';
import {
  parseCimProcesses,
  parseDockerPs,
  parseLsofCwd,
  parseLsofListen,
  parseNetstat,
  parsePsProcesses,
  parseSs,
} from './node-port-scanner.js';

describe('parseNetstat', () => {
  it('reads IPv4 and IPv6 listeners and skips connections', () => {
    const text = [
      'Active Connections',
      '  Proto  Local Address          Foreign Address        State           PID',
      '  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1180',
      '  TCP    127.0.0.1:3301         0.0.0.0:0              LISTENING       9024',
      '  TCP    127.0.0.1:3301         127.0.0.1:51000        ESTABLISHED     9024',
      '  TCP    [::]:3000              [::]:0                 LISTENING       7712',
      '  TCP    [::1]:5173             [::]:0                 LISTENING       812',
    ].join('\r\n');
    expect(parseNetstat(text)).toEqual([
      { address: '0.0.0.0', port: 135, pid: 1180 },
      { address: '127.0.0.1', port: 3301, pid: 9024 },
      { address: '::', port: 3000, pid: 7712 },
      { address: '::1', port: 5173, pid: 812 },
    ]);
  });

  it('does not depend on the English state word', () => {
    expect(parseNetstat('  TCP    0.0.0.0:3000           0.0.0.0:0              ABHOEREN        42')).toEqual([
      { address: '0.0.0.0', port: 3000, pid: 42 },
    ]);
  });
});

describe('parseSs', () => {
  it('reads addresses, ports and the first pid', () => {
    const text = [
      'LISTEN 0      511          0.0.0.0:4000       0.0.0.0:*    users:(("node",pid=321,fd=20))',
      'LISTEN 0      4096   127.0.0.53%lo:53         0.0.0.0:*',
      'LISTEN 0      511             [::]:5173          [::]:*    users:(("node",pid=322,fd=21),("node",pid=323,fd=21))',
      'LISTEN 0      511                *:8001             *:*    users:(("python3",pid=400,fd=3))',
    ].join('\n');
    expect(parseSs(text)).toEqual([
      { address: '0.0.0.0', port: 4000, pid: 321 },
      { address: '127.0.0.53', port: 53, pid: 0 },
      { address: '::', port: 5173, pid: 322 },
      { address: '0.0.0.0', port: 8001, pid: 400 },
    ]);
  });
});

describe('parseLsofListen / parseLsofCwd', () => {
  it('groups name lines under the last pid', () => {
    const text = ['p501', 'f20', 'n*:4000', 'p502', 'f21', 'n127.0.0.1:5173', 'n[::1]:5173', ''].join('\n');
    expect(parseLsofListen(text)).toEqual([
      { address: '0.0.0.0', port: 4000, pid: 501 },
      { address: '127.0.0.1', port: 5173, pid: 502 },
      { address: '::1', port: 5173, pid: 502 },
    ]);
  });

  it('reads working directories, spaces included', () => {
    const cwd = parseLsofCwd(['p501', 'fcwd', 'n/Users/me/My Projects/api', 'p502', 'fcwd', 'n/tmp'].join('\n'));
    expect(cwd.get(501)).toBe('/Users/me/My Projects/api');
    expect(cwd.get(502)).toBe('/tmp');
  });
});

describe('parsePsProcesses', () => {
  it('takes the name from the first word of the command line', () => {
    const text = [
      '  321     1  1000 /usr/bin/node /home/me/ws/fe/node_modules/.bin/vite',
      '  400   300     0 redis-server *:6379',
      '  401   300  1000 "/opt/my app/bin/server" --port 1',
    ].join('\n');
    expect(parsePsProcesses(text)).toEqual([
      { pid: 321, ppid: 1, user: '1000', name: 'node', cmd: '/usr/bin/node /home/me/ws/fe/node_modules/.bin/vite' },
      { pid: 400, ppid: 300, user: '0', name: 'redis-server', cmd: 'redis-server *:6379' },
      { pid: 401, ppid: 300, user: '1000', name: 'server', cmd: '"/opt/my app/bin/server" --port 1' },
    ]);
  });
});

describe('parseCimProcesses', () => {
  it('accepts an array or a single object, and nulls', () => {
    const many = JSON.stringify([
      { ProcessId: 4, ParentProcessId: 0, Name: 'System', CommandLine: null },
      { ProcessId: 9024, ParentProcessId: 100, Name: 'node.exe', CommandLine: 'node dist/main.js' },
    ]);
    expect(parseCimProcesses(many)).toEqual([
      { pid: 4, ppid: 0, name: 'System', cmd: '' },
      { pid: 9024, ppid: 100, name: 'node.exe', cmd: 'node dist/main.js' },
    ]);
    expect(parseCimProcesses(JSON.stringify({ ProcessId: 1, ParentProcessId: 0, Name: 'x' }))).toHaveLength(1);
    expect(parseCimProcesses('')).toEqual([]);
    expect(parseCimProcesses('not json')).toEqual([]);
  });
});

describe('parseDockerPs', () => {
  it('maps every published tcp host port to its container', () => {
    const text = [
      'proxy-1|0.0.0.0:8787->8787/tcp, [::]:8787->8787/tcp|brand-proxy|/home/me/proxy|proxy:dev',
      'db|5432/tcp|||postgres:16',
      'web|0.0.0.0:8080->80/tcp, 0.0.0.0:8443->443/tcp|||nginx',
    ].join('\n');
    expect(parseDockerPs(text)).toEqual({
      '8787': { name: 'proxy-1', project: 'brand-proxy', dir: '/home/me/proxy', image: 'proxy:dev' },
      '8080': { name: 'web', image: 'nginx' },
      '8443': { name: 'web', image: 'nginx' },
    });
    expect(parseDockerPs('')).toEqual({});
  });
});
