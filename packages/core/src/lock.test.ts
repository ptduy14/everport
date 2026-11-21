import { describe, expect, it } from 'vitest';
import { FileLock } from './lock.js';
import type { ProcessTable } from './ports.js';
import { FakeFs } from './testing/fake-fs.js';

const LOCK = '/d/everport.lock';

const procs = (alive: number[]): ProcessTable => ({
  isAlive: (pid) => alive.includes(pid),
  killTree: async () => {},
  spawnDetached: async () => undefined,
});

describe('FileLock', () => {
  it('creates the lock with our pid and removes it on release', async () => {
    const fs = new FakeFs();
    const release = await new FileLock(fs, procs([]), LOCK, 100).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toEqual({ pid: 100 });
    await release();
    expect(await fs.exists(LOCK)).toBe(false);
  });

  it('refuses while the owner is alive', async () => {
    const fs = new FakeFs().seed(LOCK, JSON.stringify({ pid: 200 }));
    await expect(new FileLock(fs, procs([200]), LOCK, 100).acquire()).rejects.toMatchObject({ code: 'LOCKED' });
    expect(fs.text(LOCK)).toBe(JSON.stringify({ pid: 200 }));
  });

  it('takes over a lock whose owner is dead', async () => {
    const fs = new FakeFs().seed(LOCK, JSON.stringify({ pid: 200 }));
    await new FileLock(fs, procs([]), LOCK, 100).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toEqual({ pid: 100 });
  });

  it('takes over a garbage lock file', async () => {
    const fs = new FakeFs().seed(LOCK, 'garbage');
    await new FileLock(fs, procs([]), LOCK, 100).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toEqual({ pid: 100 });
  });

  it('a second acquire in the same process is refused', async () => {
    const fs = new FakeFs();
    const lock = new FileLock(fs, procs([100]), LOCK, 100);
    await lock.acquire();
    await expect(lock.acquire()).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('withLock releases even when the callback throws', async () => {
    const fs = new FakeFs();
    const lock = new FileLock(fs, procs([]), LOCK, 100);
    await expect(
      lock.withLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await fs.exists(LOCK)).toBe(false);
  });
});
