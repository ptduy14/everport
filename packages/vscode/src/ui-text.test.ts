import type { TunnelStatus } from '@everport/core';
import { describe, expect, it } from 'vitest';
import {
  DOWN_MESSAGES,
  addedMessage,
  defaultLabel,
  failedSummary,
  healthMessage,
  labelError,
  removeDetail,
  subdomainNotice,
  targetError,
} from './ui-text.js';

const mk = (over: Partial<TunnelStatus> = {}): TunnelStatus => ({
  id: 'a1',
  label: 'API',
  name: 'api-7f3k',
  url: 'https://api-7f3k-everport.derrick.workers.dev',
  target: 'http://127.0.0.1:3301',
  enabled: true,
  state: 'active',
  ...over,
});

describe('target input', () => {
  it.each(['3000', 'localhost:3000', 'http://127.0.0.1:8080/api'])('accepts %s', (v) => {
    expect(targetError(v)).toBeUndefined();
  });
  it.each(['', 'abc def', '70000', 'ftp://x'])('rejects %j with a message', (v) => {
    expect(targetError(v)).toBeTruthy();
  });
  it('offers the port as the default label', () => {
    expect(defaultLabel('3000')).toBe('3000');
    expect(defaultLabel('https://localhost')).toBe('443');
  });
});

describe('label input', () => {
  it('requires a label that no other tunnel uses (case-insensitive)', () => {
    expect(labelError('  ', [])).toBeTruthy();
    expect(labelError('api', [mk()])).toContain('already used');
    expect(labelError('Web', [mk()])).toBeUndefined();
  });
  it('treats an empty label as "use the default", which must be free too', () => {
    expect(labelError('', [mk()], '3000')).toBeUndefined();
    expect(labelError('  ', [mk({ label: '3000' })], '3000')).toContain('already used');
  });
});

describe('messages', () => {
  it('has a message for every stop outcome', () => {
    expect(Object.keys(DOWN_MESSAGES).sort()).toEqual(['killed', 'not-running', 'stopped']);
    expect(DOWN_MESSAGES['not-running']).toContain('Nothing to stop');
  });

  it('gives the new URL, and the subdomain notice only with the first tunnel', () => {
    expect(addedMessage(mk())).toContain('https://api-7f3k-everport.derrick.workers.dev');
    expect(addedMessage(mk())).toContain('stays the same after restarts');
    expect(addedMessage(mk())).not.toContain('workers.dev subdomain');
    expect(addedMessage(mk(), true)).toContain('workers.dev subdomain ("derrick")');
    expect(subdomainNotice('https://x-everport.derrick.workers.dev')).toContain('("derrick")');
  });

  it('says what removing does to the address, with the real host', () => {
    expect(removeDetail(mk())).toContain('deletes api-7f3k-everport.derrick.workers.dev from your Cloudflare account');
    expect(removeDetail(mk())).toContain('same label is expected to get the same address');
  });

  it('summarises only enabled failed tunnels', () => {
    expect(failedSummary([mk()])).toBeUndefined();
    expect(failedSummary([mk({ state: 'failed' }), mk({ label: 'Web', state: 'failed', enabled: false })])).toBe(
      '1 tunnel could not start: API.',
    );
  });

  it.each([
    ['ok', 'is healthy'],
    ['not-found', 'does not know this address'],
    ['mismatch', 'something other than your relay'],
    ['unreachable', 'does not answer'],
    [undefined, 'not running'],
  ] as const)('health %s', (health, text) => {
    expect(healthMessage(mk({ health }))).toContain(text);
  });
});
