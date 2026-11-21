import { describe, expect, it } from 'vitest';
import { backoffDelay } from './backoff.js';

describe('backoffDelay', () => {
  it('doubles from one second and stops at fifteen when the random factor is at its top', () => {
    const delays = [0, 1, 2, 3, 4, 5, 6].map((attempt) => backoffDelay(attempt, () => 1));
    expect(delays).toEqual([1000, 2000, 4000, 8000, 15000, 15000, 15000]);
  });

  it('halves the delay when the random factor is at its bottom', () => {
    expect([0, 1, 4].map((attempt) => backoffDelay(attempt, () => 0))).toEqual([500, 1000, 7500]);
  });

  it('stays inside the 50% to 100% window for any random value', () => {
    for (let attempt = 0; attempt < 8; attempt++) {
      for (const r of [0, 0.25, 0.5, 0.99]) {
        const full = Math.min(15_000, 1000 * 2 ** attempt);
        const delay = backoffDelay(attempt, () => r);
        expect(delay).toBeGreaterThanOrEqual(full / 2);
        expect(delay).toBeLessThanOrEqual(full);
      }
    }
  });

  it('does not overflow for a huge attempt count', () => {
    expect(backoffDelay(10_000, () => 1)).toBe(15_000);
  });

  it('takes its base and cap from the arguments', () => {
    expect(backoffDelay(3, () => 1, 20, 100)).toBe(100);
    expect(backoffDelay(0, () => 1, 20, 100)).toBe(20);
  });
});
