import { describe, expect, it } from 'vitest';
import { FileLogger } from './logger.js';
import { FakeFs } from './testing/fake-fs.js';

const fixedNow = () => new Date('2026-11-14T10:00:00.000Z');

describe('FileLogger', () => {
  it('appends timestamped lines', async () => {
    const fs = new FakeFs();
    const log = new FileLogger(fs, '/l/everport.log', { now: fixedNow });
    log.info('hello');
    log.error('bad');
    await log.flush();
    expect(fs.text('/l/everport.log')).toBe(
      '2026-11-14T10:00:00.000Z INFO hello\n2026-11-14T10:00:00.000Z ERROR bad\n',
    );
  });

  it('rotates by size and keeps a bounded number of files', async () => {
    const fs = new FakeFs();
    const log = new FileLogger(fs, '/l/everport.log', { maxBytes: 80, keep: 2, now: fixedNow });
    for (let i = 0; i < 12; i++) log.info(`line ${i}`);
    await log.flush();
    expect(await fs.exists('/l/everport.log.1')).toBe(true);
    expect(await fs.exists('/l/everport.log.2')).toBe(true);
    expect(await fs.exists('/l/everport.log.3')).toBe(false);
    expect(fs.text('/l/everport.log')).toContain('line 11');
  });

  it('never throws when the disk fails', async () => {
    const fs = new FakeFs();
    fs.appendText = async () => {
      throw new Error('disk full');
    };
    const log = new FileLogger(fs, '/l/everport.log');
    log.info('x');
    await expect(log.flush()).resolves.toBeUndefined();
  });
});
