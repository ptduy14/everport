import type { TunnelStatus } from '@everport/core';
import { describe, expect, it } from 'vitest';
import { shouldAutoStart } from './lifecycle.js';

const mk = (over: Partial<TunnelStatus> = {}): TunnelStatus => ({
  id: 'a1',
  label: 'api',
  name: 'api-abc',
  url: 'https://api-abc-everport.me.workers.dev',
  target: 'http://127.0.0.1:3000',
  enabled: true,
  state: 'active',
  ...over,
});

describe('shouldAutoStart', () => {
  it('skips when every enabled tunnel already runs (the agent survived VS Code closing)', () => {
    expect(shouldAutoStart([mk(), mk({ id: 'b', enabled: false, state: 'stopped' })], true, true)).toBe(false);
  });
  it.each(['down', 'missing', 'failed'] as const)('starts when an enabled tunnel is %s', (state) => {
    expect(shouldAutoStart([mk(), mk({ id: 'b', state })], true, true)).toBe(true);
  });
  it('never starts when the setting is off, when not logged in, or with no tunnels', () => {
    expect(shouldAutoStart([mk({ state: 'down' })], true, false)).toBe(false);
    expect(shouldAutoStart([mk({ state: 'down' })], false, true)).toBe(false);
    expect(shouldAutoStart([], true, true)).toBe(false);
  });
});
