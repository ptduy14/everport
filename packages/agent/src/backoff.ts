/**
 * How long to wait before reconnect attempt number `attempt` (0 for the first retry):
 * min(max, base × 2^attempt), then scaled by a random factor between 0.5 and 1 so agents do not retry in lockstep.
 */
export function backoffDelay(
  attempt: number,
  random: () => number = Math.random,
  baseMs = 1000,
  maxMs = 15_000,
): number {
  return Math.round(Math.min(maxMs, baseMs * 2 ** attempt) * (0.5 + random() / 2));
}
