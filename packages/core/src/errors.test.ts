import { describe, expect, it } from 'vitest';
import { EverportError, toEverportError } from './errors.js';

describe('EverportError', () => {
  it('carries code, message and hint', () => {
    const e = new EverportError('NOT_LOGGED_IN', 'not logged in to Cloudflare', 'Run everport login');
    expect(e).toBeInstanceOf(Error);
    expect(e.code).toBe('NOT_LOGGED_IN');
    expect(e.message).toBe('not logged in to Cloudflare');
    expect(e.hint).toBe('Run everport login');
  });

  it('defaults hint to empty', () => {
    expect(new EverportError('INTERNAL', 'x').hint).toBe('');
  });
});

describe('toEverportError', () => {
  it('passes EverportError through', () => {
    const e = new EverportError('LOCKED', 'busy');
    expect(toEverportError(e)).toBe(e);
  });

  it('wraps unknown errors as INTERNAL', () => {
    expect(toEverportError(new Error('boom'))).toMatchObject({ code: 'INTERNAL', message: 'boom' });
    expect(toEverportError('text')).toMatchObject({ code: 'INTERNAL', message: 'text' });
  });
});
