import { describe, expect, it } from 'vitest';
import type { Logger } from './logger.js';
import { sumWaitMs, withWaitTiming } from './timing.js';

function recorder() {
  const lines: string[] = [];
  const logger: Logger = { info: (m) => lines.push(m), warn: () => {}, error: () => {} };
  return { lines, logger };
}

describe('withWaitTiming', () => {
  it('logs the duration of every HTTP get and sleep, and passes results through', async () => {
    const { lines, logger } = recorder();
    let t = 0;
    const clock = () => (t += 100);
    const timed = withWaitTiming(
      {
        http: { get: async () => ({ status: 200, body: new Uint8Array() }) },
        sleep: async () => {},
      },
      logger,
      clock,
    );
    expect((await timed.http.get('u')).status).toBe(200);
    await timed.sleep(5);
    expect(lines).toEqual(['wait http get 100ms', 'wait sleep 100ms']);
  });

  it('still logs when the call fails', async () => {
    const { lines, logger } = recorder();
    const timed = withWaitTiming(
      {
        http: { get: async () => Promise.reject(new Error('boom')) },
        sleep: async () => {},
      },
      logger,
    );
    await expect(timed.http.get('u')).rejects.toThrow('boom');
    expect(lines).toHaveLength(1);
  });
});

describe('sumWaitMs', () => {
  it('sums only wait lines of a Everport log', () => {
    const log = [
      '2026-11-17T13:40:19.411Z INFO wait http get 120ms',
      '2026-11-17T13:40:19.500Z INFO agent:starting Starting the agent',
      '2026-11-17T13:40:21.167Z INFO wait sleep 500ms',
      '2026-11-17T13:40:43.069Z INFO wait http get 21800ms',
    ].join('\n');
    expect(sumWaitMs(log)).toBe(22420);
  });
});
