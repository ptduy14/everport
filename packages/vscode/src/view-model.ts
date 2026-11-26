// Pure view model for the Tunnels view and status bar (no `vscode` import).
import { shortTarget, type TunnelStatus } from '@everport/core';

export { shortTarget };

export interface ItemModel {
  id: string;
  label: string;
  description: string;
  icon: { id: string; color?: string };
  /** Markdown */
  tooltip: string;
  contextValue: string;
}

/** Short reason after "Error:" on a failed row. */
const FAILED_SHORT: Record<string, string> = {
  NOT_LOGGED_IN: 'not logged in',
  RELAY_MISMATCH: 'URL taken by another Worker',
  RELAY_UNREACHABLE: 'Cloudflare unreachable',
  WRANGLER_FAILED: 'Cloudflare error',
  AGENT_NOT_RUNNING: 'background agent not running',
  AGENT_REPLACED: 'opened in another window',
};

/** One word per state, shared with the CLI. */
export const STATE_WORDS: Record<TunnelStatus['state'], string> = {
  active: 'Online',
  stopped: 'Stopped',
  down: 'Offline',
  missing: 'Missing',
  failed: 'Error',
};

export const portOf = (target: string): string => {
  const u = new URL(target);
  return u.port || (u.protocol === 'https:' ? '443' : '80');
};

/** The part of the public host that differs between tunnels (`api-everport`). */
export const publicName = (url: string): string => new URL(url).hostname.split('.')[0] ?? url;

type Health = NonNullable<TunnelStatus['health']>;
const BAD_HEALTH: Health[] = ['not-found', 'mismatch', 'unreachable'];

/** An active tunnel whose public address does not answer as our relay (only known after a health check). */
const unhealthy = (t: TunnelStatus): boolean => t.state === 'active' && !!t.health && BAD_HEALTH.includes(t.health);

/** Switched on but not served: the agent is not running, or the preview is gone. Start fixes both. */
const offline = (t: TunnelStatus): boolean => t.enabled && (t.state === 'down' || t.state === 'missing');

const needsAttention = (t: TunnelStatus): boolean => t.state === 'failed' || t.state === 'missing' || unhealthy(t);

const HEALTH_NOTES: Partial<Record<Health, { summary: string; fix: string }>> = {
  'not-found': {
    summary: "Cloudflare doesn't know this URL any more.",
    fix: 'Start All brings it back at the same URL.',
  },
  mismatch: {
    summary: 'Something other than your relay answers at this URL.',
    fix: 'Remove the tunnel and add it again with another name.',
  },
  unreachable: { summary: "The public URL doesn't answer.", fix: 'Check your connection, then Check Health again.' },
};

export interface ErrorText {
  summary: string;
  fix: string;
}

// Markdown: "  \n" is a line break inside a block; "---" draws the separator line.
function tooltipOf(t: TunnelStatus, describe: (e: NonNullable<TunnelStatus['error']>) => ErrorText): string {
  const icon = needsAttention(t) ? (t.state === 'failed' ? '$(error) ' : '$(warning) ') : '';
  const head = [
    `**${t.label}** · ${icon}${STATE_WORDS[t.state]}`,
    `\`${shortTarget(t.target)}\` → [${new URL(t.url).host}](${t.url})`,
  ].join('  \n');
  const problem: string[] = [];
  if (t.state === 'failed' && t.error) {
    const e = describe(t.error);
    problem.push(`**${e.summary}**`, ...(e.fix ? [`Fix: ${e.fix}`] : []), 'Details: Show Log');
  } else if (t.state === 'missing') {
    problem.push('**The URL is gone from Cloudflare.**', 'Fix: click Start: it comes back at the same URL.');
  } else if (t.state === 'down' && t.enabled) {
    problem.push("**The background agent isn't running.**", 'Fix: click Start, or Start All for every tunnel.');
  } else {
    const note = t.health && HEALTH_NOTES[t.health];
    if (note) problem.push(`**${note.summary}**`, `Fix: ${note.fix}`);
  }
  if (t.outdated)
    problem.push('$(warning) The relay on Cloudflare is from an older Everport. Click Start All to update it.');
  const footer = '_$(lock) Public URL · stays the same until you remove this tunnel_';
  return [head, ...(problem.length ? [problem.join('  \n')] : []), footer].join('\n\n---\n\n');
}

/** Text a busy row shows while its command runs, e.g. "Starting…". */
export type BusyVerb = string;

export function toItem(
  t: TunnelStatus,
  busy: BusyVerb | undefined,
  describe: (e: NonNullable<TunnelStatus['error']>) => ErrorText = (e) => ({ summary: e.message, fix: e.hint }),
): ItemModel {
  const port = portOf(t.target);
  // A busy row offers no actions until its command finishes.
  const contextValue = busy
    ? 'tunnel.busy'
    : [
        'tunnel',
        t.enabled ? 'on' : 'off',
        t.state === 'failed' ? 'failed' : '',
        unhealthy(t) ? 'unhealthy' : '',
        offline(t) ? 'offline' : '',
      ]
        .filter(Boolean)
        .join('.');
  const item = (icon: ItemModel['icon'], description: string): ItemModel => ({
    id: t.id,
    label: t.label,
    tooltip: tooltipOf(t, describe),
    description,
    icon,
    contextValue,
  });

  if (busy) return item({ id: 'loading~spin' }, `:${port} · ${busy}`);
  switch (t.state) {
    case 'active': {
      const description = `:${port} → ${publicName(t.url)}`;
      return unhealthy(t)
        ? item({ id: 'warning', color: 'charts.yellow' }, description)
        : item({ id: 'pass-filled', color: 'charts.green' }, description);
    }
    // Grey: states the person knows about and turns back on themselves.
    case 'stopped':
      return item({ id: 'circle-outline', color: 'disabledForeground' }, `:${port} · Stopped`);
    case 'down':
      return item({ id: 'debug-disconnect', color: 'disabledForeground' }, `:${port} · Offline`);
    case 'missing':
      return item({ id: 'warning', color: 'charts.yellow' }, `:${port} · Missing on Cloudflare`);
    case 'failed':
      return item(
        { id: 'error', color: 'errorForeground' },
        `:${port} · Error: ${FAILED_SHORT[t.error?.code ?? ''] ?? 'see details'}`,
      );
  }
}

/** One line above the list: what needs attention, or that everything is offline. Undefined when all is well. */
export function viewMessage(ts: TunnelStatus[]): string | undefined {
  const problems = ts.filter(needsAttention);
  if (problems.length > 0) {
    const n = problems.length;
    return `${n} tunnel${n > 1 ? 's need' : ' needs'} attention: ${problems.map((t) => t.label).join(', ')}`;
  }
  const enabled = ts.filter((t) => t.enabled);
  if (enabled.length > 0 && enabled.every((t) => t.state === 'down')) {
    return 'Tunnels are offline. Press Start All to bring them back at the same URLs.';
  }
  return undefined;
}

/** What the extension knows beyond the tunnels, for the status bar. */
export interface SetupState {
  checking: boolean;
  nodeMissing: boolean;
  loggedOut: boolean;
}

export function statusBar(
  ts: TunnelStatus[],
  setup: SetupState = { checking: false, nodeMissing: false, loggedOut: false },
): { text: string; tooltip: string; warning: boolean } {
  if (setup.checking)
    return { text: '$(loading~spin) Everport', tooltip: 'Everport: checking your setup…', warning: false };
  if (setup.nodeMissing)
    return {
      text: '$(warning) Everport: needs Node.js',
      tooltip: 'Everport needs Node.js 22.12 or newer',
      warning: true,
    };
  if (setup.loggedOut && ts.length === 0)
    return {
      text: '$(broadcast) Everport: log in',
      tooltip: 'Everport: log in to Cloudflare to add a tunnel',
      warning: false,
    };
  if (ts.length === 0) return { text: '$(broadcast) Everport', tooltip: 'Everport: no tunnels yet', warning: false };

  const tooltip = ['Everport', ...ts.map((t) => `${t.label}: ${STATE_WORDS[t.state]}`)].join('\n');
  const enabled = ts.filter((t) => t.enabled);
  const online = enabled.filter((t) => t.state === 'active').length;
  const issues = problemCount(ts);
  if (issues > 0)
    return { text: `$(warning) ${issues} issue${issues > 1 ? 's' : ''} · ${online} online`, tooltip, warning: true };
  if (enabled.length > 0 && enabled.every((t) => t.state === 'down'))
    return { text: '$(debug-disconnect) Tunnels offline', tooltip, warning: false };
  if (enabled.length === 0) return { text: '$(broadcast) Everport', tooltip, warning: false };
  return { text: `$(broadcast) ${online} online`, tooltip, warning: false };
}

const problemCount = (ts: TunnelStatus[]): number => ts.filter(needsAttention).length;

export const badgeCount = (ts: TunnelStatus[]): number => problemCount(ts);
