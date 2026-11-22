import { EverportError } from '@everport/core';
import { describe, expect, it } from 'vitest';
import { PROBE_ARGS, findNode, parseProbe } from './node-path.js';

describe('parseProbe', () => {
  it('reads the path and the major version', () => {
    expect(parseProbe('C:\\node\\node.exe\r\n24.22.3\r\n')).toEqual({ path: 'C:\\node\\node.exe', major: 24 });
    expect(parseProbe('/usr/bin/node\n22.1.0\n')).toEqual({ path: '/usr/bin/node', major: 22 });
  });
  it.each([undefined, '', 'only-a-path', '/usr/bin/node\nnot-a-version'])('rejects %j', (out) => {
    expect(parseProbe(out)).toBeUndefined();
  });
});

describe('findNode', () => {
  it('uses `node` from the PATH when the setting is empty, and returns the real binary path', async () => {
    const calls: [string, string[]][] = [];
    const path = await findNode('', async (cmd, args) => {
      calls.push([cmd, args]);
      return '/opt/node/bin/node\n24.0.0\n';
    });
    expect(path).toBe('/opt/node/bin/node');
    expect(calls).toEqual([['node', PROBE_ARGS]]);
  });

  it('uses the configured path', async () => {
    const seen: string[] = [];
    await findNode('  /custom/node ', async (cmd) => (seen.push(cmd), '/custom/node\n22.0.0\n'));
    expect(seen).toEqual(['/custom/node']);
  });

  it('says how to fix a missing Node', async () => {
    const error = await findNode('', async () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EverportError);
    expect((error as EverportError).message).toContain('not found on your PATH');
    expect((error as EverportError).hint).toContain('everport.nodePath');
    const custom = await findNode('/nope', async () => undefined).catch((e: unknown) => e);
    expect((custom as EverportError).message).toContain('"/nope"');
  });

  it('refuses a Node older than 22', async () => {
    const error = await findNode('', async () => '/old/node\n20.19.4\n').catch((e: unknown) => e);
    expect((error as EverportError).message).toContain('Node.js 20 is too old');
    expect((error as EverportError).hint).toContain('22');
  });
});
