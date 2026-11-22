// What wrangler says, turned into data. Formats come from real runs (wrangler 4.166.0), kept as fixtures.
import { EverportError } from '../errors.js';
import type { CliResult } from '../ports.js';

/**
 * The wrangler that every measurement was made with. `wrangler preview` is a recent feature that has had flags the docs
 * do not list, so the version is pinned exactly and bumped on purpose.
 */
export const WRANGLER_VERSION = '4.166.0';

/** The oldest Node.js this wrangler runs on (the `engines` field of wrangler 4.166.0 says >=22.12.0). Bump with it. */
export const MIN_NODE = { major: 22, minor: 12 } as const;
export const MIN_NODE_LABEL = `${MIN_NODE.major}.${MIN_NODE.minor}`;

/** True for a version string like "v22.12.0" or "24.1.0" that is at least MIN_NODE. */
export function isSupportedNode(version: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(version.trim());
  if (!match) return false;
  const [major, minor] = [Number(match[1]), Number(match[2])];
  return major > MIN_NODE.major || (major === MIN_NODE.major && minor >= MIN_NODE.minor);
}

/** What to do when the Node.js that runs wrangler is too old. */
export const NODE_TOO_OLD_HINT = `Wrangler needs Node.js ${MIN_NODE_LABEL} or newer. Switch to a newer Node.js, or in VS Code set "everport.nodePath" to its executable.`;

/** Wrangler refuses to start on a Node that is too old and says so in its own words. */
export const wranglerNeedsNewerNode = (result: CliResult): boolean =>
  /requires at least Node\.js/i.test(stripAnsi(`${result.stderr}\n${result.stdout}`));

export type WorkerState = 'none' | 'previews-only' | 'regular';

export interface PreviewInfo {
  id: string;
  /** The part of the hostname Cloudflare made from the preview name. */
  slug: string;
  name: string;
  url: string;
  /** The account's workers.dev subdomain, read from the URL. */
  subdomain: string;
}

// eslint-disable-next-line no-control-regex
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;]*m/g, '');

export function isAuthFailure(result: CliResult): boolean {
  return /non-interactive environment|CLOUDFLARE_API_TOKEN|not (logged in|authenticated)|You are not authenticated/i.test(
    stripAnsi(`${result.stderr}\n${result.stdout}`),
  );
}

export const previewMissing = (result: CliResult): boolean => /was not found/i.test(stripAnsi(result.stderr));

/** The part of a failed run worth showing a person: the error block, not the banner and the log path. */
export function summarizeFailure(result: CliResult): string {
  const lines = stripAnsi(result.stderr || result.stdout)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const start = lines.findIndex((l) => l.includes('[ERROR]'));
  const picked = start >= 0 ? lines.slice(start, start + 3) : lines.slice(-2);
  const text = picked.join(' ');
  return text === '' ? `exit code ${result.code}` : text.slice(0, 300);
}

/** The error to raise for a failed wrangler run. `what` says what we were doing, e.g. "creating the preview". */
export function wranglerError(result: CliResult, what: string): EverportError {
  if (isAuthFailure(result)) {
    return new EverportError('NOT_LOGGED_IN', 'You are not logged in to Cloudflare', 'Run "everport login".');
  }
  if (wranglerNeedsNewerNode(result)) {
    return new EverportError(
      'WRANGLER_FAILED',
      `wrangler failed while ${what}: ${summarizeFailure(result)}`,
      NODE_TOO_OLD_HINT,
    );
  }
  if (/\[code: 10003\]/.test(result.stderr)) {
    return new EverportError(
      'INVALID_NAME',
      `Cloudflare rejected the tunnel name while ${what}`,
      summarizeFailure(result),
    );
  }
  return new EverportError(
    'WRANGLER_FAILED',
    `wrangler failed while ${what}: ${summarizeFailure(result)}`,
    'Run "everport doctor".',
  );
}

/** Reads `wrangler preview --json`. The slug and the URL come from here: never computed. */
export function parsePreviewJson(stdout: string): PreviewInfo {
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  let preview: Record<string, unknown> | undefined;
  try {
    preview = (JSON.parse(stdout.slice(start, end + 1)) as { preview?: Record<string, unknown> }).preview;
  } catch {
    // handled below
  }
  const urls = preview?.['urls'];
  const url = Array.isArray(urls) ? urls[0] : undefined;
  if (!preview || typeof preview['id'] !== 'string' || typeof preview['slug'] !== 'string' || typeof url !== 'string') {
    throw new EverportError(
      'WRANGLER_FAILED',
      'wrangler answered in a shape Everport does not know',
      'Run "everport doctor".',
    );
  }
  const labels = new URL(url).hostname.split('.');
  const subdomain = labels.at(-1) === 'dev' && labels.at(-2) === 'workers' ? labels.at(-3) : undefined;
  if (!subdomain) {
    throw new EverportError(
      'WRANGLER_FAILED',
      `The preview URL ${url} is not a workers.dev address`,
      'Run "everport doctor".',
    );
  }
  const name = typeof preview['name'] === 'string' ? preview['name'] : preview['slug'];
  return { id: preview['id'], slug: preview['slug'], name, url, subdomain };
}

/** Reads `wrangler versions list --name X --json`. */
export function parseWorkerState(result: CliResult): WorkerState {
  if (result.code === 0) {
    try {
      const versions: unknown = JSON.parse(result.stdout.trim() || '[]');
      if (Array.isArray(versions)) return versions.length === 0 ? 'previews-only' : 'regular';
    } catch {
      // handled below
    }
    throw new EverportError(
      'WRANGLER_FAILED',
      'wrangler listed versions in a shape Everport does not know',
      'Run "everport doctor".',
    );
  }
  if (/\[code: 10007\]/.test(result.stderr)) return 'none';
  throw wranglerError(result, 'looking for the Worker');
}

/** Reads `wrangler whoami --json`: `{"loggedIn":false}` with exit 1 when logged out. */
export function parseLoggedIn(result: CliResult): boolean {
  try {
    const loggedIn = (JSON.parse(result.stdout) as { loggedIn?: unknown }).loggedIn;
    if (typeof loggedIn === 'boolean') return loggedIn;
  } catch {
    // handled below
  }
  throw wranglerError(result, 'checking the login');
}
