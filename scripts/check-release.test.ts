import { describe, expect, it } from 'vitest';
import { checkRelease, releaseNotes } from './check-release.mjs';

const changelog = `# Changelog

## 1.1.0

- Faster.
- Fixed the first tunnel.

## 1.0.1

- Older.
`;

const base = { cliVersion: '1.1.0', extensionVersion: '1.1.0', changelog, tagExists: () => false };

describe('releaseNotes', () => {
  it('takes the text under the version heading, up to the next one', () => {
    expect(releaseNotes(changelog, '1.1.0')).toBe('- Faster.\n- Fixed the first tunnel.');
    expect(releaseNotes(changelog, '1.0.1')).toBe('- Older.');
  });

  it('is undefined for a version without a section, and does not match a longer version', () => {
    expect(releaseNotes(changelog, '1.2.0')).toBeUndefined();
    expect(releaseNotes(changelog, '1.1')).toBeUndefined();
  });

  it('reads Windows line endings', () => {
    expect(releaseNotes(changelog.replace(/\n/g, '\r\n'), '1.0.1')).toBe('- Older.');
  });
});

describe('checkRelease', () => {
  it('releases a version that has no tag yet, with its notes', () => {
    expect(checkRelease(base)).toEqual({
      version: '1.1.0',
      release: true,
      notes: '- Faster.\n- Fixed the first tunnel.',
    });
  });

  it('does nothing when the tag exists, so a merge without a new version only runs the checks', () => {
    const asked: string[] = [];
    const result = checkRelease({ ...base, tagExists: (tag: string) => (asked.push(tag), true) });
    expect(result.release).toBe(false);
    expect(asked).toEqual(['v1.1.0']);
  });

  it('refuses packages on different versions', () => {
    expect(() => checkRelease({ ...base, extensionVersion: '1.0.1' })).toThrow(/same version/);
  });

  it('refuses a version without a changelog section', () => {
    expect(() => checkRelease({ ...base, cliVersion: '1.2.0', extensionVersion: '1.2.0' })).toThrow(/## 1\.2\.0/);
  });

  it('refuses a pre-release version, which the Marketplace does not accept', () => {
    const pre = { ...base, cliVersion: '1.2.0-beta.1', extensionVersion: '1.2.0-beta.1' };
    expect(() => checkRelease(pre)).toThrow(/major\.minor\.patch/);
  });
});
