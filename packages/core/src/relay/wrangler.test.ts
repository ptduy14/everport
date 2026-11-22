import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { CliResult } from '../ports.js';
import {
  WRANGLER_VERSION,
  isAuthFailure,
  parseLoggedIn,
  parsePreviewJson,
  parseWorkerState,
  previewMissing,
  summarizeFailure,
  wranglerError,
} from './wrangler.js';

const fixture = (name: string) =>
  readFileSync(new URL(`../testing/fixtures/wrangler/${name}`, import.meta.url), 'utf8');
const run = (code: number, stdout = '', stderr = ''): CliResult => ({ code, stdout, stderr });
const AUTH =
  "X [ERROR] In a non-interactive environment, it's necessary to set a CLOUDFLARE_API_TOKEN environment variable";

describe('the pinned version', () => {
  it('is exact, not a range: wrangler preview is an open beta', () => {
    expect(WRANGLER_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});

describe('parsePreviewJson (a real `wrangler preview --json`)', () => {
  it('reads the id, slug, name and URL, and the account subdomain from the URL', () => {
    expect(parsePreviewJson(fixture('preview-create.stdout.json'))).toEqual({
      id: '8e2ee4c4993a40c9b9155d8763f98f23',
      slug: 'sample',
      name: 'sample',
      url: 'https://sample-ep-smoke-sample.example.workers.dev',
      subdomain: 'example',
    });
  });

  it('copes with text around the JSON', () => {
    const out = `some banner\n${fixture('preview-create.stdout.json')}\ntrailing text\n`;
    expect(parsePreviewJson(out).slug).toBe('sample');
  });

  it.each([
    ['not JSON', 'nope'],
    ['no preview', '{"deployment":{}}'],
    ['no URL', '{"preview":{"id":"a","slug":"b","urls":[]}}'],
    ['a URL that is not workers.dev', '{"preview":{"id":"a","slug":"b","urls":["https://example.com"]}}'],
  ])('refuses output with %s', (_name, stdout) => {
    expect(() => parsePreviewJson(stdout)).toThrowError(expect.objectContaining({ code: 'WRANGLER_FAILED' }));
  });
});

describe('parseWorkerState (`wrangler versions list --json`)', () => {
  it('reads exit 1 with code 10007 as a Worker that does not exist', () => {
    expect(parseWorkerState(run(1, '\n', fixture('versions-missing.stderr.txt')))).toBe('none');
  });

  it('reads an empty list as a Worker that only has previews', () => {
    expect(parseWorkerState(run(0, fixture('versions-previews-only.stdout.txt')))).toBe('previews-only');
  });

  it('reads a list with versions as a regular Worker', () => {
    expect(parseWorkerState(run(0, '[{"id":"v1"}]'))).toBe('regular');
  });

  it('turns a login problem into NOT_LOGGED_IN and anything else into WRANGLER_FAILED', () => {
    expect(() => parseWorkerState(run(1, '', AUTH))).toThrowError(expect.objectContaining({ code: 'NOT_LOGGED_IN' }));
    expect(() => parseWorkerState(run(1, '', 'X [ERROR] something else'))).toThrowError(
      expect.objectContaining({ code: 'WRANGLER_FAILED' }),
    );
    expect(() => parseWorkerState(run(0, 'not json'))).toThrowError(
      expect.objectContaining({ code: 'WRANGLER_FAILED' }),
    );
  });
});

describe('parseLoggedIn (`wrangler whoami --json`)', () => {
  it('reads the flag, including the exit-1 answer of a logged-out wrangler', () => {
    expect(parseLoggedIn(run(0, '{"loggedIn":true,"authType":"OAuth Token"}'))).toBe(true);
    expect(parseLoggedIn(run(1, '{"loggedIn":false}\n'))).toBe(false);
  });

  it('refuses output that is not JSON with the flag', () => {
    expect(() => parseLoggedIn(run(1, '', 'X [ERROR] boom'))).toThrowError(
      expect.objectContaining({ code: 'WRANGLER_FAILED' }),
    );
  });
});

describe('failures', () => {
  it('recognises a login problem however wrangler words it', () => {
    expect(isAuthFailure(run(1, '', AUTH))).toBe(true);
    expect(isAuthFailure(run(1, '', 'You are not authenticated'))).toBe(true);
    expect(isAuthFailure(run(1, '', 'X [ERROR] not logged in'))).toBe(true);
    expect(isAuthFailure(run(1, '', 'X [ERROR] This Worker does not exist [code: 10007]'))).toBe(false);
  });

  it('recognises a preview that does not exist', () => {
    expect(previewMissing(run(1, '', fixture('preview-missing.stderr.txt')))).toBe(true);
    expect(previewMissing(run(1, '', 'X [ERROR] other'))).toBe(false);
  });

  it('summarizes a failure by its error block, not by the banner or the log path', () => {
    const summary = summarizeFailure(run(1, '', fixture('versions-missing.stderr.txt')));
    expect(summary).toContain('[ERROR]');
    expect(summary).toContain('10007');
    expect(summary).not.toContain('Logs were written');
  });

  it('falls back to the exit code when wrangler said nothing', () => {
    expect(summarizeFailure(run(7))).toBe('exit code 7');
  });

  it('maps Cloudflare error 10003 to INVALID_NAME and puts what wrangler said in the message', () => {
    const error = wranglerError(run(1, '', 'X [ERROR] bad name [code: 10003]'), 'creating the preview');
    expect(error.code).toBe('INVALID_NAME');
    const other = wranglerError(run(1, '', 'X [ERROR] it broke'), 'creating the preview');
    expect(other.code).toBe('WRANGLER_FAILED');
    expect(other.message).toContain('creating the preview');
    expect(other.message).toContain('it broke');
  });
});
