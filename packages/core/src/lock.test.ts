import { describe, expect, it } from 'vitest';
import { FileLock, startedBeforeBoot } from './lock.js';
import type { ProcessTable } from './ports.js';
import { FakeFs } from './testing/fake-fs.js';

const LOCK = '/d/everport.lock';
const NOW = 1_000_000_000;
const now = () => NOW;

const procs = (alive: number[], bootTime?: number): ProcessTable => ({
  isAlive: (pid) => alive.includes(pid),
  killTree: async () => {},
  spawnDetached: async () => undefined,
  ...(bootTime !== undefined && { bootTime: () => bootTime }),
});

describe('FileLock', () => {
  it('creates the lock with our pid and start time, and removes it on release', async () => {
    const fs = new FakeFs();
    const release = await new FileLock(fs, procs([]), LOCK, 100, now).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toEqual({ pid: 100, startedAt: NOW });
    await release();
    expect(await fs.exists(LOCK)).toBe(false);
  });

  it('refuses while the owner is alive', async () => {
    const fs = new FakeFs().seed(LOCK, JSON.stringify({ pid: 200 }));
    await expect(new FileLock(fs, procs([200]), LOCK, 100, now).acquire()).rejects.toMatchObject({ code: 'LOCKED' });
    expect(fs.text(LOCK)).toBe(JSON.stringify({ pid: 200 }));
  });

  it('takes over a lock whose owner is dead', async () => {
    const fs = new FakeFs().seed(LOCK, JSON.stringify({ pid: 200 }));
    await new FileLock(fs, procs([]), LOCK, 100, now).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toMatchObject({ pid: 100 });
  });

  it('takes over a lock written before the last restart, even when another process now has that pid', async () => {
    const before = JSON.stringify({ pid: 200, startedAt: NOW - 3_600_000 });
    const fs = new FakeFs().seed(LOCK, before);
    await new FileLock(fs, procs([200], NOW - 600_000), LOCK, 100, now).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toMatchObject({ pid: 100 });
  });

  it('respects a lock taken after the last restart', async () => {
    const fs = new FakeFs().seed(LOCK, JSON.stringify({ pid: 200, startedAt: NOW - 1000 }));
    await expect(new FileLock(fs, procs([200], NOW - 600_000), LOCK, 100, now).acquire()).rejects.toMatchObject({
      code: 'LOCKED',
    });
  });

  it('takes over a garbage lock file', async () => {
    const fs = new FakeFs().seed(LOCK, 'garbage');
    await new FileLock(fs, procs([]), LOCK, 100, now).acquire();
    expect(JSON.parse(fs.text(LOCK)!)).toMatchObject({ pid: 100 });
  });

  it('a second raw acquire in the same process is refused', async () => {
    const fs = new FakeFs();
    const lock = new FileLock(fs, procs([100]), LOCK, 100, now);
    await lock.acquire();
    await expect(lock.acquire()).rejects.toMatchObject({ code: 'LOCKED' });
  });

  it('queues withLock calls of the same process instead of refusing them', async () => {
    const fs = new FakeFs();
    const lock = new FileLock(fs, procs([100]), LOCK, 100, now);
    const order: string[] = [];
    let finishFirst: () => void = () => {};
    const first = lock.withLock(async () => {
      order.push('first start');
      await new Promise<void>((resolve) => (finishFirst = resolve));
      order.push('first end');
    });
    const second = lock.withLock(async () => void order.push('second'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first start', 'first end', 'second']);
  });

  it('keeps the queue going after a call fails', async () => {
    const fs = new FakeFs();
    const lock = new FileLock(fs, procs([]), LOCK, 100, now);
    await expect(
      lock.withLock(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(await fs.exists(LOCK)).toBe(false);
    await expect(lock.withLock(async () => 'next')).resolves.toBe('next');
  });
});

describe('startedBeforeBoot', () => {
  it('is true only for a time well before the last restart, and false when the boot time is unknown', () => {
    expect(startedBeforeBoot(NOW - 3_600_000, procs([], NOW - 600_000))).toBe(true);
    expect(startedBeforeBoot(NOW - 610_000, procs([], NOW - 600_000))).toBe(false); // within the slack
    expect(startedBeforeBoot(NOW, procs([], NOW - 600_000))).toBe(false);
    expect(startedBeforeBoot(NOW - 3_600_000, procs([]))).toBe(false);
    expect(startedBeforeBoot(undefined, procs([], NOW))).toBe(false);
  });
});
