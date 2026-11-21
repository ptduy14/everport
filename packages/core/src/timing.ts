import type { Logger } from './logger.js';
import type { HttpClient } from './ports.js';

/** Log line prefix the smoke test sums to separate Everport's own time from waits on external services. */
export const WAIT_PREFIX = 'wait ';

export interface Timed {
  http: HttpClient;
  sleep: (ms: number) => Promise<void>;
}

/** Wraps every port that waits on an external service (HTTP, deliberate sleeps) to log its duration. */
export function withWaitTiming(p: Timed, logger: Logger, now: () => number = () => performance.now()): Timed {
  const timed = async <T>(kind: string, work: () => Promise<T>): Promise<T> => {
    const start = now();
    try {
      return await work();
    } finally {
      logger.info(`${WAIT_PREFIX}${kind} ${Math.round(now() - start)}ms`);
    }
  };
  return {
    http: { get: (url, opts) => timed('http get', () => p.http.get(url, opts)) },
    sleep: (ms) => timed('sleep', () => p.sleep(ms)),
  };
}

/** Sums the `wait …ms` lines of a Everport log. */
export function sumWaitMs(log: string): number {
  let total = 0;
  for (const m of log.matchAll(/ wait .* (\d+)ms$/gm)) total += Number(m[1]);
  return total;
}
