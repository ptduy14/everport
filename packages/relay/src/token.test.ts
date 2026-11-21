import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { connectToken, timingSafeEqual, verifyToken } from './token.js';

const SECRET = 'a3f1'.repeat(16);

describe('connectToken', () => {
  it('matches HMAC-SHA256 of "connect:<tunnel>" computed by node:crypto', async () => {
    const expected = createHmac('sha256', SECRET).update('connect:fe').digest('hex');
    expect(await connectToken(SECRET, 'fe')).toBe(expected);
  });

  it('is lowercase hex of 64 characters', async () => {
    expect(await connectToken(SECRET, 'fe')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('differs per tunnel and per secret', async () => {
    const fe = await connectToken(SECRET, 'fe');
    expect(await connectToken(SECRET, 'be')).not.toBe(fe);
    expect(await connectToken('other', 'fe')).not.toBe(fe);
  });
});

describe('verifyToken', () => {
  it('accepts the right token and rejects a wrong or truncated one', async () => {
    const token = await connectToken(SECRET, 'fe');
    expect(await verifyToken(SECRET, 'fe', token)).toBe(true);
    expect(await verifyToken(SECRET, 'be', token)).toBe(false);
    expect(await verifyToken(SECRET, 'fe', token.slice(1))).toBe(false);
    expect(await verifyToken(SECRET, 'fe', '')).toBe(false);
  });
});

describe('timingSafeEqual', () => {
  it('is true only for identical strings', () => {
    expect(timingSafeEqual('abc', 'abc')).toBe(true);
    expect(timingSafeEqual('abc', 'abd')).toBe(false);
    expect(timingSafeEqual('abc', 'abcd')).toBe(false);
    expect(timingSafeEqual('', '')).toBe(true);
  });
});
