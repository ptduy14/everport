// Pure view model for the Tunnels view and status bar (no `vscode` import).
import type { TunnelStatus } from '@everport/core';

export interface ItemModel {
  id: string;
  label: string;
  description: string;
  icon: { id: string; color?: string };
  /** Markdown */
  tooltip: string;
  contextValue: string;
}

const FAILED_SHORT: Record<string, string> = {
  NOT_LOGGED_IN: 'not logged in',
  RELAY_MISMATCH: 'address taken',
  RELAY_UNREACHABLE: 'Cloudflare unreachable',
  WRANGLER_FAILED: 'Cloudflare error',
  AGENT_NOT_RUNNING: 'agent not running',
  AGENT_REPLACED: 'agent replaced',
};

export const portOf = (target: string): string => {
  const u = new URL(target);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
};

type Health = NonNullable<TunnelStatus['health']>;
const BAD_HEALTH: Health[] = ['not-found', 'mismatch', 'unreachable'];

/** An active tunnel whose public address does not answer as our relay (only known after a health check). */
const unhealthy = (t: TunnelStatus): boolean => t.state === 'active' && !!t.health && BAD_HEALTH.includes(t.health);

function problemCount(ts: TunnelStatus[]): number {
  return ts.filter((t) => t.state === 'failed' || t.state === 'missing' || unhealthy(t)).length;
}

const STATE_WORDS: Record<TunnelStatus['state'], string> = {
  active: 'active',
  stopped: 'stopped',
  down: 'agent down',
  missing: 'not on Cloudflare',
  failed: 'failed',
};
const HEALTH_WORDS: Record<Health, string> = {
  ok: 'healthy',
  'not-found': 'address not found',
  mismatch: 'address taken by something else',
  unreachable: 'not answering',
};
const HEALTH_NOTES: Partial<Record<Health, string>> = {
  'not-found': '$(warning) The relay does not know this address. Start All brings it back.',
  mismatch: '$(error) Something other than your relay answers at this address. Remove the tunnel and add it again.',
  unreachable: '$(warning) The public address does not answer. Check your connection, then Check Health again.',
};

// Markdown: "  \n" is a line break inside a block; "---" draws the separator line.
function tooltipOf(t: TunnelStatus): string {
  // Local service first, then where it is published: the direction the traffic is forwarded.
  const head = [
    `**${t.label}** · ${STATE_WORDS[t.state]}${t.health ? ` · ${HEALTH_WORDS[t.health]}` : ''}`,
    `\`${t.target}\``, // code span: not turned into a link
    `→ [${t.url}](${t.url})`,
  ].join('  \n');
  // One fact per line, shortest first, so it scans quickly.
  const badges = [
    '$(globe) Public',
    '$(lock) URL stays the same until you remove the tunnel',
    '$(plug) Keeps running when VS Code is closed',
  ].join('  \n');
  const notes: string[] = [];
  if (t.state === 'failed' && t.error) notes.push(`$(error) ${t.error.message}`, t.error.hint);
  if (t.state === 'missing') notes.push('$(warning) The address is gone from Cloudflare. Start All brings it back.');
  const healthNote = t.health && HEALTH_NOTES[t.health];
  if (healthNote) notes.push(healthNote);
  if (t.outdated) notes.push('$(info) The relay on Cloudflare was deployed by an older Everport.');
  return [head, badges, ...(notes.length ? [notes.join('  \n')] : [])].join('\n\n---\n\n');
}

export function toItem(t: TunnelStatus, busy: boolean): ItemModel {
  const port = portOf(t.target);
  // A busy row offers no actions until its command finishes.
  const contextValue = busy
    ? 'tunnel.busy'
    : ['tunnel', t.enabled ? 'on' : 'off', t.state === 'failed' ? 'failed' : '', unhealthy(t) ? 'unhealthy' : '']
        .filter(Boolean)
        .join('.');
  const item = (icon: ItemModel['icon'], description: string): ItemModel => ({
    id: t.id,
    label: t.label,
    tooltip: tooltipOf(t),
    description,
    icon,
    contextValue,
  });

  if (busy) {
    const doing = t.state === 'active' ? 'stopping…' : 'starting…';
    return item({ id: 'loading~spin' }, `:${port} → ${new URL(t.url).host} · ${doing}`);
  }
  switch (t.state) {
    case 'active': {
      const description = `:${port} → ${new URL(t.url).host}`;
      return unhealthy(t)
        ? item({ id: 'warning', color: 'charts.yellow' }, description)
        : item({ id: 'pass-filled', color: 'charts.green' }, description);
    }
    case 'stopped':
      return item({ id: 'circle-outline' }, `:${port} · stopped`);
    case 'down':
      return item({ id: 'debug-disconnect' }, `:${port} · agent down`);
    case 'missing':
      return item({ id: 'warning', color: 'charts.yellow' }, `:${port} · not on Cloudflare`);
    case 'failed':
      return item(
        { id: 'error', color: 'errorForeground' },
        `:${port} · ${FAILED_SHORT[t.error?.code ?? ''] ?? 'failed'}`,
      );
  }
}

export function statusBar(ts: TunnelStatus[]): { text: string; tooltip: string; warning: boolean } {
  if (ts.length === 0) return { text: '$(broadcast) Everport', tooltip: 'Everport: no tunnels yet', warning: false };
  const n = ts.filter((t) => t.enabled).length;
  const active = ts.filter((t) => t.enabled && t.state === 'active').length;
  const problems = problemCount(ts);
  return {
    text: `$(broadcast) Everport ${active}/${n}${problems > 0 ? ' $(warning)' : ''}`,
    tooltip: `Everport: ${active} of ${n} tunnels running${problems > 0 ? `\n${problems} need attention` : ''}`,
    warning: problems > 0,
  };
}

export const badgeCount = (ts: TunnelStatus[]): number => problemCount(ts);
