import { describe, expect, it } from 'vitest';
import { resolveNpx } from './node-wrangler.js';

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
