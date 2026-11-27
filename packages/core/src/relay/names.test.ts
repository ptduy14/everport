import { describe, expect, it } from 'vitest';
import { normalizeTunnelName } from './names.js';

const fixed = () => 'abcd';

describe('normalizeTunnelName', () => {
  it.each([
    ['fe', 'fe'],
    ['Backend API', 'backend-api'],
    ['my_app.v2', 'my-app-v2'],
    ['  --edge--  ', 'edge'],
    ['A  B', 'a-b'],
    ['3000', '3000'],
  ])('turns %j into %j', (label, expected) => {
    expect(normalizeTunnelName(label, 'everport', fixed)).toBe(expected);
  });

  it('strips accents and Vietnamese letters instead of letting Cloudflare reject them with error 10003', () => {
    expect(normalizeTunnelName('Café API', 'everport', fixed)).toBe('cafe-api');
    expect(normalizeTunnelName('Tiếng Việt', 'everport', fixed)).toBe('tieng-viet');
    expect(normalizeTunnelName('Đường đi', 'everport', fixed)).toBe('duong-di');
  });

  it('gives a random name to a label with nothing usable in it', () => {
    expect(normalizeTunnelName('日本語', 'everport', fixed)).toBe('t-abcd');
    expect(normalizeTunnelName('!!!', 'everport', fixed)).toBe('t-abcd');
    expect(normalizeTunnelName('', 'everport', fixed)).toBe('t-abcd');
  });

  it('leaves room for the Worker name in the 63-character hostname label, and never ends on a hyphen', () => {
    const name = normalizeTunnelName(`${'a'.repeat(60)}-b`, 'everport', fixed);
    expect(name.length).toBe(63 - 1 - 'everport'.length);
    const cut = normalizeTunnelName(`${'a'.repeat(53)}-${'b'.repeat(10)}`, 'everport', fixed);
    expect(cut).toBe('a'.repeat(53));
    expect(cut.endsWith('-')).toBe(false);
  });

  it('adds a suffix to a name equal to the Worker name, as Cloudflare would, so the preview is not deployed twice', () => {
    expect(normalizeTunnelName('everport', 'everport', fixed)).toBe('everport-abcd');
    expect(normalizeTunnelName('Everport', 'everport', fixed)).toBe('everport-abcd');
    expect(normalizeTunnelName('everport-2', 'everport', fixed)).toBe('everport-2');
  });

  it('refuses a Worker name so long that no tunnel name fits', () => {
    expect(() => normalizeTunnelName('fe', 'w'.repeat(62), fixed)).toThrowError(
      expect.objectContaining({ code: 'INVALID_NAME' }),
    );
  });
});
