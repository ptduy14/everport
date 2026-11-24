import { describe, expect, it } from 'vitest';
import { ansi, lowerFirst, useColor } from './paint.js';

describe('paint', () => {
  it('colours only for a terminal without NO_COLOR', () => {
    expect(useColor(true, {})).toBe(true);
    expect(useColor(false, {})).toBe(false);
    expect(useColor(undefined, {})).toBe(false);
    expect(useColor(true, { NO_COLOR: '1' })).toBe(false);
    expect(useColor(true, { TERM: 'dumb' })).toBe(false);
  });

  it('wraps text in an ANSI colour and resets it', () => {
    expect(ansi('x', 'red')).toBe('\x1b[31mx\x1b[0m');
  });

  it('lowers the first word of a hint, but not an acronym', () => {
    expect(lowerFirst('Run "everport up".')).toBe('run "everport up".');
    expect(lowerFirst('DNS is slow')).toBe('DNS is slow');
  });
});
