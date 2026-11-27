import type { TunnelStatus } from '@everport/core';
import { describe, expect, it } from 'vitest';
import {
  DOWN_MESSAGES,
  addedMessage,
  cliToVsCode,
  defaultLabel,
  doctorReport,
  errorText,
  failedNotice,
  healthMessage,
  labelError,
  progressText,
  PREPARING_TITLE,
  removeDetail,
  removeQuestion,
  startedWaitingMessage,
  startAllSummary,
  subdomainNotice,
  targetError,
  urlPreview,
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

describe('name input', () => {
  it('requires a name that no other tunnel uses (case-insensitive)', () => {
    expect(labelError('  ', [])).toBeTruthy();
    expect(labelError('api', [mk()])).toContain('already used');
    expect(labelError('Web', [mk()])).toBeUndefined();
  });
  it('treats an empty name as "use the default", which must be free too', () => {
    expect(labelError('', [mk()], '3000')).toBeUndefined();
    expect(labelError('  ', [mk({ label: '3000' })], '3000')).toContain('already used');
  });
  it('previews the URL from an existing tunnel, normalised like the real name', () => {
    expect(urlPreview('Billing API', [mk()], 'everport')).toBe('https://billing-api-everport.derrick.workers.dev');
  });
  it('previews the URL before the first tunnel without inventing the subdomain', () => {
    expect(urlPreview('web', [], 'everport')).toBe('https://web-everport.<your-subdomain>.workers.dev');
  });
});

describe('messages', () => {
  it('has a message for every stop outcome, without the forced-stop detail', () => {
    expect(Object.keys(DOWN_MESSAGES).sort()).toEqual(['killed', 'not-running', 'stopped']);
    expect(DOWN_MESSAGES.killed).not.toContain('force');
    expect(DOWN_MESSAGES['not-running']).toContain('Nothing to stop');
  });

  it('gives the new URL, and the subdomain notice only with the first tunnel', () => {
    expect(addedMessage(mk())).toContain('is live at https://api-7f3k-everport.derrick.workers.dev');
    expect(addedMessage(mk())).not.toContain('subdomain');
    expect(addedMessage(mk(), true)).toContain('"derrick" is your Cloudflare subdomain');
    expect(subdomainNotice('https://x-everport.derrick.workers.dev')).toContain('"derrick"');
  });

  it('says what to do next when the app behind a new or started tunnel is not running, without calling it an error', () => {
    expect(addedMessage(mk(), false, false)).toBe(
      'API is live at https://api-7f3k-everport.derrick.workers.dev. Nothing is running on localhost:3301 yet: start your app and requests will reach it.',
    );
    expect(startedWaitingMessage(mk())).toBe(
      'API is online. Nothing is running on localhost:3301 yet: start your app and requests will reach it.',
    );
    expect(healthMessage(mk({ health: 'ok', localDown: true }))).toBe(
      'API is healthy: its public URL answers. Nothing is running on localhost:3301 yet: start your app and requests will reach it.',
    );
  });

  it('says what removing does to the address, with the real host', () => {
    expect(removeQuestion(mk())).toBe('Remove "API" and its public URL?');
    expect(removeDetail(mk())).toContain('https://api-7f3k-everport.derrick.workers.dev stops working right away');
    expect(removeDetail(mk())).toContain('use Stop instead');
  });

  it('turns core events into short progress steps', () => {
    expect(progressText({ type: 'relay:setup', message: 'long core text' }, true)).toContain('First tunnel only');
    expect(progressText({ type: 'tunnel:creating', message: 'x' }, true)).toBe(
      'Creating the public URL… (first tunnel: about 10 s)',
    );
    expect(progressText({ type: 'tunnel:creating', message: 'x' }, false)).toBe('Creating the public URL…');
    expect(progressText({ type: 'agent:starting', message: 'x' }, false)).toBe('Connecting…');
    expect(progressText({ type: 'wrangler:preparing', message: 'core text' }, false)).toBe(PREPARING_TITLE);
    expect(progressText({ type: 'agent:ready', message: 'x' }, false)).toBeUndefined();
    expect(progressText({ type: 'tunnel:ready', message: 'api is ready' }, false)).toBe('api is ready');
  });

  it.each([
    ['ok', 'is healthy'],
    ['not-found', "doesn't know this URL"],
    ['mismatch', 'something other than your relay'],
    ['unreachable', "doesn't answer"],
    [undefined, 'not running'],
  ] as const)('health %s', (health, text) => {
    expect(healthMessage(mk({ health }))).toContain(text);
  });
});

describe('errors in VS Code words', () => {
  it('turns CLI commands in core hints into buttons', () => {
    expect(cliToVsCode('Run "everport up": it brings it back.')).toBe('Click Start All: it brings it back.');
    expect(cliToVsCode('Check the network, then run "everport up" again.')).toBe(
      'Check the network, then click Start All.',
    );
    expect(cliToVsCode('Run "everport login", then "everport up".')).toBe('Log in to Cloudflare, then Start All.');
    expect(cliToVsCode('none yet: the first "everport add" creates it')).toBe(
      'none yet: the first Add Tunnel creates it',
    );
  });

  it('has its own words for known codes and keeps the core text for the rest', () => {
    expect(errorText({ code: 'RELAY_UNREACHABLE', message: 'fetch failed', hint: '' }).summary).toBe(
      "Couldn't reach Cloudflare.",
    );
    expect(errorText({ code: 'CONFIG_INVALID', message: 'Bad file', hint: 'Run "everport up"' })).toEqual({
      summary: 'Bad file.',
      fix: 'Click Start All.',
    });
  });

  it('names one failed tunnel with its reason and offers Retry', () => {
    const failed = mk({ label: 'Web', state: 'failed', error: { code: 'RELAY_UNREACHABLE', message: 'x', hint: '' } });
    const notice = failedNotice([mk(), failed, mk({ label: 'Off', state: 'failed', enabled: false })]);
    expect(notice?.text).toBe(
      "Web couldn't start. Couldn't reach Cloudflare. Check your connection, then click Retry. 1 other tunnel is online.",
    );
    expect(notice?.retry).toBe(failed);
    expect(failedNotice([mk()])).toBeUndefined();
  });

  it('counts several failed tunnels', () => {
    const notice = failedNotice([mk({ state: 'failed' }), mk({ label: 'Web', state: 'failed' })]);
    expect(notice).toEqual({ text: "2 tunnels couldn't start: API, Web." });
  });

  it('sums up Start All for the log', () => {
    expect(startAllSummary([mk(), mk({ state: 'failed' })])).toEqual({
      ok: false,
      text: 'Start all: 1 of 2 online, 1 failed',
    });
    expect(startAllSummary([mk()])).toEqual({ ok: true, text: 'Start all: 1 of 1 online' });
  });
});

describe('doctorReport', () => {
  const checks = [
    { name: 'node', ok: true, detail: '24.11.0' },
    { name: 'wrangler', ok: true, detail: '4.166.0' },
    { name: 'cloudflare login', ok: false, detail: 'not logged in', hint: 'Run "everport login".' },
    { name: 'tunnel web', ok: true, detail: 'https://web' },
  ];

  it('keeps technical checks at debug while they pass, and always shows failures with a fix', () => {
    const { lines } = doctorReport(checks);
    expect(lines.find((l) => l.text.includes('4.166.0'))?.level).toBe('debug');
    expect(lines.find((l) => l.text.includes('24.11.0'))).toEqual({ level: 'info', text: '  ✓ Node.js     24.11.0' });
    expect(lines.filter((l) => l.level === 'error').map((l) => l.text)).toEqual([
      '  ✗ Cloudflare  not logged in',
      '      Fix: Log in to Cloudflare.',
    ]);
    expect(lines.at(-1)).toEqual({ level: 'warn', text: 'Doctor: 1 problem found' });
  });

  it('names a single problem in the notice', () => {
    expect(doctorReport(checks).notice).toBe('Doctor: 1 problem. Cloudflare: not logged in. Log in to Cloudflare.');
    expect(doctorReport(checks.filter((c) => c.ok)).notice).toBe('Doctor: everything looks fine.');
  });
});
