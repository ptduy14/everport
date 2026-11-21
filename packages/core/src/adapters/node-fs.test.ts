import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { NodeFileSystem } from './node-fs.js';

const dirs: string[] = [];
afterEach(async () => {
  for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
});

const tmp = async () => {
  const d = await mkdtemp(join(tmpdir(), 'everport-fs-'));
  dirs.push(d);
  return d;
};

describe('NodeFileSystem.writeTextPrivate', () => {
  it('creates parent directories and writes the text', async () => {
    const fs = new NodeFileSystem();
    const file = join(await tmp(), 'a', 'b', 'secret');
    await fs.writeTextPrivate(file, 'hush');
    expect(await fs.readText(file)).toBe('hush');
  });

  it.skipIf(process.platform === 'win32')(
    'is readable by the owner only, even over an existing wide-open file',
    async () => {
      const fs = new NodeFileSystem();
      const file = join(await tmp(), 'secret');
      await fs.writeText(file, 'old');
      await fs.writeTextPrivate(file, 'new');
      expect((await stat(file)).mode & 0o777).toBe(0o600);
    },
  );
});
