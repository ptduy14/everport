// User-facing text and input rules for the commands. Pure: no `vscode` import, so it is unit-tested.
import {
  normalizeTarget,
  normalizeTunnelName,
  shortTarget,
  type DoctorCheck,
  type StopOutcome,
  type TunnelStatus,
} from '@everport/core';
import { portOf } from './view-model.js';

export const DOWN_MESSAGES: Record<StopOutcome, string> = {
  stopped: 'Tunnels stopped. Your URLs are kept; Start All brings them back.',
  killed: 'Tunnels stopped. Your URLs are kept; Start All brings them back.',
  'not-running': 'Nothing to stop: no tunnel is running.',
};

/** Error text for the target input box, or undefined when the input is usable. */
export function targetError(input: string): string | undefined {
  try {
    normalizeTarget(input);
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** The label offered by default: the port ("3000"). */
export const defaultLabel = (target: string): string => String(portOf(normalizeTarget(target)));

/** With a `fallback`, an empty input means "use the fallback", so the fallback must be free too. */
export function labelError(input: string, existing: TunnelStatus[], fallback?: string): string | undefined {
  const label = input.trim() || fallback || '';
  if (!label) return 'A name is required.';
  if (existing.some((t) => t.label.toLowerCase() === label.toLowerCase()))
    return `"${label}" is already used by another tunnel.`;
  return undefined;
}

/**
 * The public URL a new tunnel is expected to get. Taken from an existing tunnel's host when there is one; Cloudflare
 * has the last word, so this is a preview, not a promise.
 */
export function urlPreview(label: string, existing: TunnelStatus[], workerName: string): string {
  const name = normalizeTunnelName(label, workerName, () => 'xxxx');
  const sample = existing[0];
  if (sample) {
    const host = new URL(sample.url).hostname;
    const rest = host.startsWith(`${sample.name}-`) ? host.slice(sample.name.length + 1) : undefined;
    if (rest) return `https://${name}-${rest}`;
  }
  return `https://${name}-${workerName}.<your-subdomain>.workers.dev`;
}

const subdomainOf = (url: string): string => new URL(url).hostname.split('.').at(-3) ?? '';

/** Said with the very first tunnel: the address holds the account's workers.dev subdomain. */
export const subdomainNotice = (url: string): string =>
  `Heads-up: "${subdomainOf(url)}" is your Cloudflare subdomain and may come from your email. It is in every URL you share.`;

export const addedMessage = (t: TunnelStatus, first = false): string =>
  `${t.label} is live at ${t.url}. This URL won't change.${first ? ` ${subdomainNotice(t.url)}` : ''}`;

export const removeQuestion = (t: TunnelStatus): string => `Remove "${t.label}" and its public URL?`;

export const removeDetail = (t: TunnelStatus): string =>
  `${t.url} stops working right away. Webhooks, OAuth redirects and connectors that use it will fail.\n\n` +
  'To pause it and keep the URL, use Stop instead.';

export const REMOVE_BUTTON = 'Remove Tunnel';

export const removeLocalQuestion = (t: TunnelStatus, why: string): string =>
  `Couldn't remove "${t.label}" from Cloudflare. ${why} Remove it from this list only?`;

export const REMOVE_LOCAL_DETAIL =
  'Everport forgets the tunnel on this computer. Its preview may stay on Cloudflare and keep its URL; you can delete it later in the Cloudflare dashboard.';

export const REMOVE_LOCAL_BUTTON = 'Remove from List Only';

export const LOGIN_WAIT_TITLE = 'Waiting for you in the browser…';
export const LOGIN_WAIT_TEXT = "Log in to Cloudflare, then click Allow. This closes by itself when you're done.";
export const LOGGED_IN_TEXT = 'Logged in to Cloudflare. Add a tunnel to get your first public URL.';

/** Progress text for a core event, in VS Code words; undefined keeps the step shown before. */
export function progressText(e: { type: string; message: string }, first: boolean): string | undefined {
  switch (e.type) {
    case 'relay:setup':
      return "Setting up Everport in your Cloudflare account. First tunnel only: 10–20 s, longer if Cloudflare's tool is still downloading.";
    case 'tunnel:creating':
      return first ? 'Creating the public URL… (first tunnel: 10–20 s)' : 'Creating the public URL…';
    case 'agent:starting':
      return 'Connecting…';
    case 'agent:ready':
      return undefined;
    default:
      return e.message;
  }
}

/** Core hints name CLI commands; in VS Code the same step is a button. */
export function cliToVsCode(text: string): string {
  return text
    .replace(/\b([Rr])un "everport up"( again| here)?/g, (_, r: string) => `${r === 'R' ? 'Click' : 'click'} Start All`)
    .replace(/\b([Rr])un "everport login"/g, (_, r: string) => `${r === 'R' ? 'Log' : 'log'} in to Cloudflare`)
    .replace(/\b([Rr])un "everport add"/g, (_, r: string) => `${r === 'R' ? 'Add' : 'add'} a tunnel`)
    .replace(/\b[Rr]un "everport ls" to see your tunnels/g, 'See the Everport view for your tunnels')
    .replace(/"everport up"/g, 'Start All')
    .replace(/"everport add"/g, 'Add Tunnel');
}

const withStop = (s: string): string => (/[.!?]$/.test(s) ? s : `${s}.`);

/** What went wrong and what to do, in words for the VS Code user. Unknown codes keep the core's text. */
const ERROR_TEXT: Record<string, { summary: string; fix: string }> = {
  NOT_LOGGED_IN: {
    summary: "You're not logged in to Cloudflare.",
    fix: 'Log in to Cloudflare from the Everport view.',
  },
  RELAY_UNREACHABLE: { summary: "Couldn't reach Cloudflare.", fix: 'Check your connection, then click Retry.' },
  RELAY_MISMATCH: {
    summary: 'Something other than your relay answers at this URL.',
    fix: 'Remove the tunnel and add it again with another name.',
  },
  AGENT_NOT_RUNNING: { summary: "The background agent isn't running.", fix: 'Click Start All.' },
  AGENT_REPLACED: {
    summary: 'Another VS Code window or the CLI took over this tunnel.',
    fix: 'Click Retry to bring it back here; the other window then loses it.',
  },
};

export function errorText(e: { code: string; message: string; hint: string }): { summary: string; fix: string } {
  return ERROR_TEXT[e.code] ?? { summary: withStop(e.message), fix: e.hint ? withStop(cliToVsCode(e.hint)) : '' };
}

/** After Start All: undefined when nothing failed; one failed tunnel is named with its reason. */
export function failedNotice(ts: TunnelStatus[]): { text: string; retry?: TunnelStatus } | undefined {
  const enabled = ts.filter((t) => t.enabled);
  const failed = enabled.filter((t) => t.state === 'failed');
  if (failed.length === 0) return undefined;
  const online = enabled.filter((t) => t.state === 'active').length;
  const others = online > 0 ? ` ${online} other ${online > 1 ? 'tunnels are' : 'tunnel is'} online.` : '';
  const [only] = failed;
  if (failed.length === 1 && only) {
    const why = only.error ? errorText(only.error) : undefined;
    return {
      text: `${only.label} couldn't start.${why ? ` ${why.summary} ${why.fix}` : ''}${others}`.trim(),
      retry: only,
    };
  }
  return { text: `${failed.length} tunnels couldn't start: ${failed.map((t) => t.label).join(', ')}.${others}` };
}

/** One line for the log after Start All. */
export function startAllSummary(ts: TunnelStatus[]): { ok: boolean; text: string } {
  const enabled = ts.filter((t) => t.enabled);
  const online = enabled.filter((t) => t.state === 'active').length;
  const failed = enabled.filter((t) => t.state === 'failed').length;
  if (enabled.length === 0) return { ok: true, text: 'Start all: no tunnel is switched on' };
  return failed
    ? { ok: false, text: `Start all: ${online} of ${enabled.length} online, ${failed} failed` }
    : { ok: true, text: `Start all: ${online} of ${enabled.length} online` };
}

export function healthMessage(t: TunnelStatus): string {
  switch (t.health) {
    case 'ok':
      return t.localDown
        ? `${t.label}: its public URL works, but nothing answers at ${shortTarget(t.target)}. Start your local service.`
        : `${t.label} is healthy: its public URL answers.`;
    case 'not-found':
      return `${t.label}: Cloudflare doesn't know this URL any more. Start All brings it back at the same URL.`;
    case 'mismatch':
      return `${t.label}: something other than your relay answers at this URL. Remove the tunnel and add it again.`;
    case 'unreachable':
      return `${t.label}: the public URL doesn't answer. Check your connection and try again.`;
    default:
      return `${t.label} is not running, so there is nothing to check.`;
  }
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

/** Doctor checks a VS Code user acts on; the rest are logged at debug level while they pass. */
const DOCTOR_NAMES: Record<string, string> = {
  node: 'Node.js',
  'cloudflare login': 'Cloudflare',
  relay: 'Relay',
  agent: 'Agent',
};
const doctorName = (name: string): string | undefined =>
  DOCTOR_NAMES[name] ?? (name.startsWith('tunnel ') ? name.slice('tunnel '.length) : undefined);

export function doctorReport(checks: DoctorCheck[]): { lines: { level: LogLevel; text: string }[]; notice: string } {
  const lines: { level: LogLevel; text: string }[] = [];
  const width = Math.max(...checks.map((c) => (doctorName(c.name) ?? c.name).length), 0);
  for (const c of checks) {
    const shown = doctorName(c.name);
    const name = (shown ?? c.name).padEnd(width);
    const detail = cliToVsCode(c.detail);
    if (c.ok) {
      lines.push({ level: shown ? 'info' : 'debug', text: `  ✓ ${name}  ${detail}` });
    } else {
      lines.push({ level: 'error', text: `  ✗ ${name}  ${detail}` });
      if (c.hint) lines.push({ level: 'error', text: `      Fix: ${cliToVsCode(c.hint)}` });
    }
  }
  const failed = checks.filter((c) => !c.ok);
  const [only] = failed;
  let notice = 'Doctor: everything looks fine.';
  if (failed.length === 1 && only) {
    notice = `Doctor: 1 problem. ${doctorName(only.name) ?? only.name}: ${withStop(cliToVsCode(only.detail))}${only.hint ? ` ${withStop(cliToVsCode(only.hint))}` : ''}`;
  } else if (failed.length > 1) {
    notice = `Doctor: ${failed.length} problems: ${failed.map((c) => doctorName(c.name) ?? c.name).join(', ')}.`;
  }
  lines.push({
    level: failed.length ? 'warn' : 'info',
    text: failed.length ? `Doctor: ${failed.length} problem${failed.length > 1 ? 's' : ''} found` : 'Doctor: all good',
  });
  return { lines, notice };
}
