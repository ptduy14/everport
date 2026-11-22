// User-facing text and input rules for the commands. Pure: no `vscode` import, so it is unit-tested.
import { normalizeTarget, type StopOutcome, type TunnelStatus } from '@everport/core';
import { portOf } from './view-model.js';

export const DOWN_MESSAGES: Record<StopOutcome, string> = {
  stopped: 'Tunnels stopped. Your URLs are kept; Start All brings them back.',
  killed: 'Tunnels stopped (the agent had to be ended by force). Your URLs are kept; Start All brings them back.',
  'not-running': 'Nothing to stop: the Everport agent is not running.',
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
  if (!label) return 'A label is required.';
  if (existing.some((t) => t.label.toLowerCase() === label.toLowerCase()))
    return `"${label}" is already used by another tunnel.`;
  return undefined;
}

/** Said with the very first tunnel: the address holds the account's workers.dev subdomain. */
export function subdomainNotice(url: string): string {
  const subdomain = new URL(url).hostname.split('.').at(-3) ?? '';
  return (
    `Note: this address is public and contains your Cloudflare workers.dev subdomain ("${subdomain}"), ` +
    'which Cloudflare may have taken from your email address. Check that you are happy with it before you share a link.'
  );
}

export const addedMessage = (t: TunnelStatus, first = false): string =>
  `${t.label} is public at ${t.url}. The URL stays the same after restarts.${first ? `\n\n${subdomainNotice(t.url)}` : ''}`;

export const removeQuestion = (t: TunnelStatus): string => `Remove the tunnel "${t.label}"?`;

export const removeDetail = (t: TunnelStatus): string =>
  `This deletes ${new URL(t.url).host} from your Cloudflare account. Links that point to it stop working, ` +
  'and the address is not kept for you: a new tunnel gets a new address.';

export function failedSummary(ts: TunnelStatus[]): string | undefined {
  const failed = ts.filter((t) => t.enabled && t.state === 'failed');
  if (failed.length === 0) return undefined;
  return `${failed.length} tunnel${failed.length > 1 ? 's' : ''} could not start: ${failed.map((t) => t.label).join(', ')}.`;
}

export function healthMessage(t: TunnelStatus): string {
  switch (t.health) {
    case 'ok':
      return `${t.label} is healthy: ${t.url} answers.`;
    case 'not-found':
      return `${t.label}: the relay does not know this address. Start All brings it back.`;
    case 'mismatch':
      return `${t.label}: something other than your relay answers at this address. Remove the tunnel and add it again.`;
    case 'unreachable':
      return `${t.label}: the public address does not answer. Check your connection and try again.`;
    default:
      return `${t.label} is not running, so there is nothing to check.`;
  }
}
