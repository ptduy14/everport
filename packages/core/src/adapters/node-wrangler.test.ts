import { describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  NodeWranglerRunner,
  npxArgs,
  npxDirFromPath,
  resolveNpx,
  withNodeOnPath,
  wranglerEnv,
  wranglerScript,
} from './node-wrangler.js';

describe('resolveNpx', () => {
  it('runs npx-cli.js with node itself on Windows, so no shell is needed (npx.cmd cannot be spawned directly)', () => {
    const npx = resolveNpx('C:\\node\\node.exe', 'win32', (p) => p === 'C:\\node\\node_modules\\npm\\bin\\npx-cli.js');
    expect(npx).toEqual({
      command: 'C:\\node\\node.exe',
      prefix: ['C:\\node\\node_modules\\npm\\bin\\npx-cli.js'],
      shell: false,
    });
  });

  it('finds npx-cli.js in lib/node_modules next to the node binary on macOS and Linux', () => {
    const npx = resolveNpx('/usr/local/bin/node', 'linux', (p) =>
      p.replaceAll('\\', '/').endsWith('lib/node_modules/npm/bin/npx-cli.js'),
    );
    expect(npx.command).toBe('/usr/local/bin/node');
    expect(npx.prefix[0]).toMatch(/lib[\\/]node_modules[\\/]npm[\\/]bin[\\/]npx-cli\.js$/);
    expect(npx.shell).toBe(false);
  });

  it('falls back to the npx on PATH when npx-cli.js is not where it was expected', () => {
    expect(resolveNpx('/odd/node', 'linux', () => false)).toEqual({ command: 'npx', prefix: [], shell: false });
    expect(resolveNpx('C:\\odd\\node.exe', 'win32', () => false)).toEqual({
      command: 'npx.cmd',
      prefix: [],
      shell: true,
    });
  });

  it('finds npx for the node that runs these tests', () => {
    const npx = resolveNpx();
    expect(npx.command.length).toBeGreaterThan(0);
  });
});

describe('withNodeOnPath', () => {
  it("puts the chosen node's folder first, so wrangler's `node` shim finds the same node", () => {
    const env = withNodeOnPath({ PATH: 'C:\\Program Files\\nodejs' }, 'C:\\fnm\\v24\\node.exe', 'win32');
    expect(env['PATH']).toBe('C:\\fnm\\v24;C:\\Program Files\\nodejs');
  });

  it('keeps the spelling of the variable ("Path" on Windows) instead of adding a second one', () => {
    const env = withNodeOnPath({ Path: 'C:\\Windows' }, 'C:\\tools\\node.exe', 'win32');
    expect(env).toEqual({ Path: 'C:\\tools;C:\\Windows' });
  });

  it('uses the colon separator on macOS and Linux and works without a PATH', () => {
    expect(withNodeOnPath({ PATH: '/usr/bin' }, '/opt/node/bin/node', 'linux')['PATH']).toBe('/opt/node/bin:/usr/bin');
    expect(withNodeOnPath({}, '/opt/node/bin/node', 'linux')['PATH']).toBe('/opt/node/bin');
  });

  it('leaves the environment alone for a bare "node"', () => {
    const env = { PATH: '/usr/bin' };
    expect(withNodeOnPath(env, 'node', 'linux')).toBe(env);
  });
});

describe('npxArgs', () => {
  const secrets = 'C:\\Users\\John Smith\\AppData\\Local\\everport\\relay\\secrets-1.json';

  it('passes the arguments as they are when no shell runs them', () => {
    const npx = { command: 'node.exe', prefix: ['npx-cli.js'], shell: false };
    expect(npxArgs(npx, '4.166.0', ['preview', '--secrets-file', secrets])).toEqual([
      'npx-cli.js',
      '-y',
      'wrangler@4.166.0',
      'preview',
      '--secrets-file',
      secrets,
    ]);
  });

  it('quotes a path with a space for cmd in the npx.cmd fallback, so it stays one argument', () => {
    const npx = { command: 'npx.cmd', prefix: [], shell: true };
    expect(npxArgs(npx, '4.166.0', ['preview', '--secrets-file', secrets])).toEqual([
      '-y',
      'wrangler@4.166.0',
      'preview',
      '--secrets-file',
      `"${secrets}"`,
    ]);
  });
});

describe('npxDirFromPath', () => {
  it("finds npx's folder from the first PATH entry npx gives the command it runs", () => {
    const path = String.raw`C:\Users\A B\AppData\Local\npm-cache\_npx\ffb31b46e02e6278\node_modules\.bin;C:\Windows`;
    expect(npxDirFromPath(path, 'win32')).toBe(String.raw`C:\Users\A B\AppData\Local\npm-cache\_npx\ffb31b46e02e6278`);
    expect(npxDirFromPath('/home/a/.npm/_npx/0a1b/node_modules/.bin:/usr/bin\n', 'linux')).toBe(
      '/home/a/.npm/_npx/0a1b',
    );
  });

  it('is undefined when the PATH has no npx folder', () => {
    expect(npxDirFromPath(String.raw`C:\Windows;C:\node`, 'win32')).toBeUndefined();
  });
});

describe('wranglerScript', () => {
  it('points at the entry script of the wrangler package', () => {
    expect(wranglerScript('/c/_npx/ab', 'linux')).toBe('/c/_npx/ab/node_modules/wrangler/bin/wrangler.js');
  });
});

describe('wranglerEnv', () => {
  it('drops a WRANGLER_LOG level, whatever its spelling: debug logs on stdout break --json', () => {
    expect(wranglerEnv({ WRANGLER_LOG: 'debug', wrangler_log: 'log', A: '1' }, false)).toEqual({ A: '1', CI: '1' });
  });

  it('sets CI except for an interactive run (login)', () => {
    expect(wranglerEnv({ CI: '1', A: '1' }, true)).toEqual({ A: '1' });
  });
});

describe('NodeWranglerRunner', () => {
  it('starts the wrangler it noted with node directly, without npx', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ep-runner-'));
    const npxDir = join(dir, '_npx', 'abc123');
    mkdirSync(join(npxDir, 'node_modules', 'wrangler', 'bin'), { recursive: true });
    writeFileSync(
      join(npxDir, 'node_modules', 'wrangler', 'bin', 'wrangler.js'),
      'console.log(JSON.stringify({ args: process.argv.slice(2), log: process.env.WRANGLER_LOG ?? null, ci: process.env.CI }));',
    );
    const stateFile = join(dir, 'wrangler.json');
    writeFileSync(stateFile, JSON.stringify({ version: '9.9.9', npxDir }));
    const heard: string[] = [];
    const runner = new NodeWranglerRunner('9.9.9', process.execPath, process.platform, {
      stateFile,
      onPreparing: (m) => heard.push(m),
    });
    try {
      const result = await runner.run(['whoami', '--json'], { env: { WRANGLER_LOG: 'debug' } });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({ args: ['whoami', '--json'], log: null, ci: '1' });
      expect(heard).toEqual([]); // nothing to prepare
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
