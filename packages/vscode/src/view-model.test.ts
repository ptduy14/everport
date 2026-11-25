import { describe, expect, it } from 'vitest';
import type { TunnelStatus } from '@everport/core';
import { badgeCount, publicName, shortTarget, statusBar, toItem, viewMessage } from './view-model.js';

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

const host = 'api-abc-everport.me.workers.dev';

describe('toItem', () => {
  it('shows a busy spinner with the verb of the running command', () => {
    const m = toItem(mk({ state: 'stopped' }), 'Starting…');
    expect(m.icon).toEqual({ id: 'loading~spin' });
    expect(m.description).toBe(':3000 · Starting…');
    expect(m.contextValue).toBe('tunnel.busy'); // only Copy URL / Open while busy
    expect(toItem(mk(), 'Removing…').description).toBe(':3000 · Removing…');
  });

  it.each([undefined, 'ok'] as const)(
    'active with health %s is green and shows the distinct part of the URL',
    (health) => {
      const m = toItem(mk(health ? { health } : {}), undefined);
      expect(m.icon).toEqual({ id: 'pass-filled', color: 'charts.green' });
      expect(m.description).toBe(':3000 → api-abc-everport');
      expect(m.contextValue).toBe('tunnel.on');
    },
  );

  it.each(['not-found', 'mismatch', 'unreachable'] as const)(
    'active with health %s is yellow and unhealthy',
    (health) => {
      const m = toItem(mk({ health }), undefined);
      expect(m.icon).toEqual({ id: 'warning', color: 'charts.yellow' });
      expect(m.contextValue).toBe('tunnel.on.unhealthy');
    },
  );

  it('online but the local service does not answer: a warning, and it needs attention', () => {
    const t = mk({ localDown: true });
    const m = toItem(t, undefined);
    expect(m.icon).toEqual({ id: 'warning', color: 'charts.yellow' });
    expect(m.description).toBe(":3000 · Your service isn't running");
    expect(m.contextValue).toBe('tunnel.on.unhealthy');
    expect(m.tooltip).toContain('Nothing answers at `localhost:3000`');
    expect(badgeCount([t])).toBe(1);
    expect(viewMessage([t])).toBe('1 tunnel needs attention: api');
  });

  it('stopped', () => {
    const m = toItem(mk({ state: 'stopped', enabled: false }), undefined);
    expect(m.icon).toEqual({ id: 'circle-outline', color: 'disabledForeground' });
    expect(m.description).toBe(':3000 · Stopped');
    expect(m.contextValue).toBe('tunnel.off');
  });

  it('down is Offline and offers Start, not Stop', () => {
    const m = toItem(mk({ state: 'down' }), undefined);
    expect(m.icon).toEqual({ id: 'debug-disconnect', color: 'disabledForeground' });
    expect(m.description).toBe(':3000 · Offline');
    expect(m.contextValue).toBe('tunnel.on.offline');
    expect(m.tooltip).toContain("background agent isn't running");
  });

  it('missing offers Start too', () => {
    const m = toItem(mk({ state: 'missing' }), undefined);
    expect(m.icon).toEqual({ id: 'warning', color: 'charts.yellow' });
    expect(m.description).toBe(':3000 · Missing on Cloudflare');
    expect(m.contextValue).toBe('tunnel.on.offline');
    expect(m.tooltip).toContain('same URL');
  });

  it.each([
    ['NOT_LOGGED_IN', 'not logged in'],
    ['RELAY_MISMATCH', 'URL taken by another Worker'],
    ['RELAY_UNREACHABLE', 'Cloudflare unreachable'],
    ['WRANGLER_FAILED', 'Cloudflare error'],
    ['SOMETHING_NEW', 'see details'],
  ])('failed %s', (code, short) => {
    const m = toItem(mk({ state: 'failed', error: { code, message: 'boom', hint: 'try this' } }), undefined);
    expect(m.icon).toEqual({ id: 'error', color: 'errorForeground' });
    expect(m.description).toBe(`:3000 · Error: ${short}`);
    expect(m.contextValue).toBe('tunnel.on.failed');
    expect(m.tooltip).toContain('**boom**');
    expect(m.tooltip).toContain('Fix: try this');
  });

  it('uses the error wording it is given', () => {
    const m = toItem(mk({ state: 'failed', error: { code: 'X', message: 'raw', hint: 'h' } }), undefined, () => ({
      summary: 'Nice words.',
      fix: 'Click Retry.',
    }));
    expect(m.tooltip).toContain('**Nice words.**  \nFix: Click Retry.');
    expect(m.tooltip).not.toContain('raw');
  });

  it('defaults the port by scheme', () => {
    expect(toItem(mk({ target: 'http://example.test' }), undefined).description).toContain(':80 ');
    expect(toItem(mk({ target: 'https://example.test' }), undefined).description).toContain(':443 ');
  });

  it('builds the tooltip: state, route, problem, then one quiet footer', () => {
    const t = toItem(mk({ health: 'ok' }), undefined).tooltip;
    expect(t).toContain('**api** · Online');
    expect(t).toContain(`\`localhost:3000\` → [${host}](https://${host})`);
    expect(t.split('\n\n---\n\n')).toHaveLength(2);
    expect(t).toContain('stays the same until you remove this tunnel');
    expect(toItem(mk({ health: 'unreachable' }), undefined).tooltip).toContain("The public URL doesn't answer");
    expect(toItem(mk({ health: 'mismatch' }), undefined).tooltip).toContain('Something other than your relay');
    expect(toItem(mk({ health: 'not-found' }), undefined).tooltip).toContain("doesn't know this URL");
  });

  it('mentions an outdated relay without calling it a problem', () => {
    const ts = [mk({ health: 'ok', outdated: true })];
    expect(toItem(ts[0]!, undefined).tooltip).toContain('older Everport');
    expect(badgeCount(ts)).toBe(0);
    expect(toItem(ts[0]!, undefined).contextValue).toBe('tunnel.on');
  });

  it('combines contextValue parts', () => {
    expect(
      toItem(mk({ state: 'failed', health: 'unreachable', error: { code: 'X', message: 'm', hint: 'h' } }), undefined)
        .contextValue,
    ).toBe('tunnel.on.failed'); // health only matters for active tunnels
    expect(toItem(mk({ enabled: false, state: 'down' }), undefined).contextValue).toBe('tunnel.off');
  });
});

describe('shortTarget and publicName', () => {
  it('shortens a plain local HTTP target only', () => {
    expect(shortTarget('http://127.0.0.1:3000')).toBe('localhost:3000');
    expect(shortTarget('http://127.0.0.1:3000/api')).toBe('http://127.0.0.1:3000/api');
    expect(shortTarget('https://127.0.0.1:3000')).toBe('https://127.0.0.1:3000');
    expect(shortTarget('http://192.168.1.5:3000')).toBe('http://192.168.1.5:3000');
  });
  it('keeps the first label of the public host', () => {
    expect(publicName(`https://${host}`)).toBe('api-abc-everport');
  });
});

describe('viewMessage', () => {
  it('is empty when all is well', () => {
    expect(viewMessage([mk(), mk({ id: 'b', state: 'stopped', enabled: false })])).toBeUndefined();
  });
  it('names the tunnels that need attention', () => {
    expect(viewMessage([mk(), mk({ id: 'b', label: 'web', state: 'failed' })])).toBe('1 tunnel needs attention: web');
    expect(viewMessage([mk({ state: 'missing' }), mk({ id: 'b', label: 'web', health: 'unreachable' })])).toBe(
      '2 tunnels need attention: api, web',
    );
  });
  it('says when every enabled tunnel is offline', () => {
    expect(viewMessage([mk({ state: 'down' }), mk({ id: 'b', state: 'stopped', enabled: false })])).toContain(
      'Tunnels are offline',
    );
  });
});

describe('statusBar and badgeCount', () => {
  it('reflects the setup before any tunnel', () => {
    expect(statusBar([], { checking: true, nodeMissing: false, loggedOut: false }).text).toBe(
      '$(loading~spin) Everport',
    );
    expect(statusBar([], { checking: false, nodeMissing: true, loggedOut: false })).toMatchObject({
      text: '$(warning) Everport: needs Node.js',
      warning: true,
    });
    expect(statusBar([], { checking: false, nodeMissing: false, loggedOut: true }).text).toBe(
      '$(broadcast) Everport: log in',
    );
    expect(statusBar([])).toMatchObject({ text: '$(broadcast) Everport', warning: false });
    expect(badgeCount([])).toBe(0);
  });

  it('counts online tunnels when all is well', () => {
    const ts = [
      mk(),
      mk({ id: 'b', label: 'web', state: 'stopped', enabled: false }),
      mk({ id: 'c', label: 'doc', health: 'ok' }),
    ];
    const sb = statusBar(ts);
    expect(sb.text).toBe('$(broadcast) 2 online');
    expect(sb.tooltip).toBe('Everport\napi: Online\nweb: Stopped\ndoc: Online');
    expect(sb.warning).toBe(false);
    expect(badgeCount(ts)).toBe(0);
  });

  it('puts problems first', () => {
    const ts = [
      mk(),
      mk({ id: 'b', state: 'failed' }),
      mk({ id: 'c', state: 'missing' }),
      mk({ id: 'd', health: 'unreachable' }),
    ];
    expect(statusBar(ts)).toMatchObject({ text: '$(warning) 3 issues · 2 online', warning: true });
    expect(badgeCount(ts)).toBe(3);
  });

  it('says when the tunnels are offline', () => {
    expect(statusBar([mk({ state: 'down' }), mk({ id: 'b', state: 'down' })]).text).toBe(
      '$(debug-disconnect) Tunnels offline',
    );
  });
});
