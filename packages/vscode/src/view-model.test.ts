import { describe, expect, it } from 'vitest';
import type { TunnelStatus } from '@everport/core';
import { badgeCount, statusBar, toItem } from './view-model.js';

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
  it('shows a busy spinner', () => {
    const m = toItem(mk({ state: 'stopped' }), true);
    expect(m.icon).toEqual({ id: 'loading~spin' });
    expect(m.description).toBe(`:3000 → ${host} · starting…`);
    expect(m.contextValue).toBe('tunnel.busy'); // only Copy URL / Open while busy
    expect(toItem(mk({ state: 'active' }), true).description).toBe(`:3000 → ${host} · stopping…`);
  });

  it.each([undefined, 'ok'] as const)('active with health %s is green', (health) => {
    const m = toItem(mk(health ? { health } : {}), false);
    expect(m.icon).toEqual({ id: 'pass-filled', color: 'charts.green' });
    expect(m.description).toBe(`:3000 → ${host}`);
    expect(m.contextValue).toBe('tunnel.on');
  });

  it.each(['not-found', 'mismatch', 'unreachable'] as const)(
    'active with health %s is yellow and unhealthy',
    (health) => {
      const m = toItem(mk({ health }), false);
      expect(m.icon).toEqual({ id: 'warning', color: 'charts.yellow' });
      expect(m.description).toBe(`:3000 → ${host}`);
      expect(m.contextValue).toBe('tunnel.on.unhealthy');
    },
  );

  it('stopped', () => {
    const m = toItem(mk({ state: 'stopped', enabled: false }), false);
    expect(m.icon).toEqual({ id: 'circle-outline' });
    expect(m.description).toBe(':3000 · stopped');
    expect(m.contextValue).toBe('tunnel.off');
  });

  it('down', () => {
    const m = toItem(mk({ state: 'down' }), false);
    expect(m.icon).toEqual({ id: 'debug-disconnect' });
    expect(m.description).toBe(':3000 · agent down');
  });

  it('missing', () => {
    const m = toItem(mk({ state: 'missing' }), false);
    expect(m.icon).toEqual({ id: 'warning', color: 'charts.yellow' });
    expect(m.description).toBe(':3000 · not on Cloudflare');
    expect(m.tooltip).toContain('Start All brings it back');
  });

  it.each([
    ['NOT_LOGGED_IN', 'not logged in'],
    ['RELAY_MISMATCH', 'address taken'],
    ['RELAY_UNREACHABLE', 'Cloudflare unreachable'],
    ['WRANGLER_FAILED', 'Cloudflare error'],
    ['SOMETHING_NEW', 'failed'],
  ])('failed %s', (code, short) => {
    const m = toItem(mk({ state: 'failed', error: { code, message: 'boom', hint: 'try this' } }), false);
    expect(m.icon).toEqual({ id: 'error', color: 'errorForeground' });
    expect(m.description).toBe(`:3000 · ${short}`);
    expect(m.contextValue).toBe('tunnel.on.failed');
    expect(m.tooltip).toContain('$(error) boom');
    expect(m.tooltip).toContain('try this');
  });

  it('defaults the port by scheme', () => {
    expect(toItem(mk({ target: 'http://example.test' }), false).description).toContain(':80 ');
    expect(toItem(mk({ target: 'https://example.test' }), false).description).toContain(':443 ');
  });

  it('builds the tooltip', () => {
    const t = toItem(mk({ health: 'ok' }), false).tooltip;
    expect(t).toContain('**api** · active · healthy');
    // local target first, then the public URL it is forwarded to
    expect(t).toContain(`\`http://127.0.0.1:3000\`  \n→ [https://${host}](https://${host})`);
    expect(t).toContain(
      '$(globe) Public  \n$(lock) URL stays the same until you remove the tunnel  \n$(plug) Keeps running when VS Code is closed',
    );
    // compact lines inside a block, separator lines between blocks
    expect(t.split('\n\n---\n\n')).toHaveLength(2);
    expect(toItem(mk({ state: 'down' }), false).tooltip).toContain('**api** · agent down');
    expect(toItem(mk({ health: 'unreachable' }), false).tooltip).toContain(
      '$(warning) The public address does not answer',
    );
    expect(toItem(mk({ health: 'mismatch' }), false).tooltip).toContain('$(error) Something other than your relay');
    expect(toItem(mk({ health: 'not-found' }), false).tooltip).toContain('does not know this address');
  });

  it('mentions an outdated relay without calling it a problem', () => {
    const ts = [mk({ health: 'ok', outdated: true })];
    expect(toItem(ts[0]!, false).tooltip).toContain('older Everport');
    expect(badgeCount(ts)).toBe(0);
    expect(toItem(ts[0]!, false).contextValue).toBe('tunnel.on');
  });

  it('combines contextValue parts', () => {
    expect(
      toItem(mk({ state: 'failed', health: 'unreachable', error: { code: 'X', message: 'm', hint: 'h' } }), false)
        .contextValue,
    ).toBe('tunnel.on.failed'); // health only matters for active tunnels
    expect(toItem(mk({ enabled: false, state: 'stopped' }), false).contextValue).toBe('tunnel.off');
  });
});

describe('statusBar and badgeCount', () => {
  it('is bare with no tunnels', () => {
    expect(statusBar([])).toMatchObject({ text: '$(broadcast) Everport', warning: false });
    expect(badgeCount([])).toBe(0);
  });

  it('counts running tunnels when all is well', () => {
    const ts = [mk(), mk({ id: 'b', state: 'stopped', enabled: false }), mk({ id: 'c', health: 'ok' })];
    expect(statusBar(ts)).toEqual({
      text: '$(broadcast) Everport 2/2',
      tooltip: 'Everport: 2 of 2 tunnels running',
      warning: false,
    });
    expect(badgeCount(ts)).toBe(0);
  });

  it('flags problems', () => {
    const ts = [
      mk(),
      mk({ id: 'b', state: 'failed' }),
      mk({ id: 'c', state: 'missing' }),
      mk({ id: 'd', health: 'unreachable' }),
    ];
    expect(statusBar(ts)).toEqual({
      text: '$(broadcast) Everport 2/4 $(warning)',
      tooltip: 'Everport: 2 of 4 tunnels running\n3 need attention',
      warning: true,
    });
    expect(badgeCount(ts)).toBe(3);
  });
});
