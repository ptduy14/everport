// When to start tunnels and refresh the view. Pure: no `vscode` import, so it is unit-tested.
import type { TunnelStatus } from '@everport/core';

export const POLL_VISIBLE_MS = 10_000;
/** Slower while the view is hidden, so the status bar does not go stale. */
export const POLL_HIDDEN_MS = 60_000;

/**
 * Bring tunnels up on VS Code start only when it is needed: the agent survives VS Code closing, so
 * usually everything is still running and `up` would be wasted.
 */
export function shouldAutoStart(ts: TunnelStatus[], loggedIn: boolean, startOnOpen: boolean): boolean {
  return startOnOpen && loggedIn && ts.some((t) => t.enabled && t.state !== 'active');
}
