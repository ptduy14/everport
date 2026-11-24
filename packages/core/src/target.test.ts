import { describe, expect, it } from 'vitest';
import { InvalidTargetError, normalizeTarget, shortTarget } from './target.js';

describe('normalizeTarget', () => {
  it.each([
    ['3000', 'http://127.0.0.1:3000'],
    [' 8080 ', 'http://127.0.0.1:8080'],
    ['localhost:3000', 'http://localhost:3000'],
    ['127.0.0.1:3301', 'http://127.0.0.1:3301'],
    ['http://localhost:3000/', 'http://localhost:3000'],
    ['https://127.0.0.1:8443', 'https://127.0.0.1:8443'],
    ['http://localhost:3000/api', 'http://localhost:3000/api'],
  ])('%s -> %s', (input, expected) => {
    expect(normalizeTarget(input)).toBe(expected);
  });

  it.each(['', '   ', '0', '70000', 'localhost:99999', 'ftp://localhost:21', 'http://'])('rejects %j', (input) => {
    expect(() => normalizeTarget(input)).toThrow(InvalidTargetError);
  });
});

describe('shortTarget', () => {
  it('shortens a plain local HTTP target only', () => {
    expect(shortTarget('http://127.0.0.1:3000')).toBe('localhost:3000');
    expect(shortTarget('http://127.0.0.1:3000/api')).toBe('http://127.0.0.1:3000/api');
    expect(shortTarget('https://127.0.0.1:3000')).toBe('https://127.0.0.1:3000');
    expect(shortTarget('http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
  });
});
