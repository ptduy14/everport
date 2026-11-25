import { shortTarget, type DoctorCheck, type TunnelStatus } from '@everport/core';
import { lowerFirst, plain, type Paint, type Style } from './paint.js';

/** Pads on the plain text, then lets `paint` colour a cell, so colour codes never break the columns. */
export function renderTable(
  headers: string[],
  rows: string[][],
  paintCell: (cell: string, row: number, col: number) => string = (c) => c,
): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[], row: number) =>
    cells
      .map((c, i) => (row < 0 ? c.padEnd(widths[i] ?? 0) : paintCell(c.padEnd(widths[i] ?? 0), row, i)))
      .join('  ')
      .trimEnd();
  return [
    line(headers, -1),
    line(
      widths.map((w) => '-'.repeat(w)),
      -1,
    ),
    ...rows.map((r, i) => line(r, i)),
  ].join('\n');
}

/** Same words as the VS Code view; `--json` keeps the raw state. */
const STATE_TEXT: Record<TunnelStatus['state'], string> = {
  active: 'online',
  stopped: 'stopped',
  down: 'offline',
  missing: 'missing',
  failed: 'error',
};

const STATE_STYLE: Partial<Record<TunnelStatus['state'], Style>> = {
  active: 'green',
  missing: 'yellow',
  failed: 'red',
};

export function tunnelTable(tunnels: TunnelStatus[], paint: Paint = plain): string {
  if (tunnels.length === 0) return 'No tunnels yet. Add one with: everport add <port>';
  const withHealth = tunnels.some((t) => t.health !== undefined);
  const headers = ['ID', 'LABEL', 'URL', 'TARGET', 'STATE', ...(withHealth ? ['HEALTH'] : [])];
  const rows = tunnels.map((t) => [
    t.id,
    t.label,
    t.url,
    shortTarget(t.target),
    STATE_TEXT[t.state],
    ...(withHealth ? [t.health ?? '-'] : []),
  ]);
  const stateCol = headers.indexOf('STATE');
  return renderTable(headers, rows, (cell, row, col) => {
    const style = col === stateCol ? STATE_STYLE[tunnels[row]!.state] : undefined;
    return style ? paint(cell, style) : cell;
  });
}

const fix = (hint: string): string => `  Fix: ${lowerFirst(hint)}`;

/** Problems worth a line under the table: failed tunnels and health findings, each with its fix. */
export function tunnelWarnings(tunnels: TunnelStatus[], paint: Paint = plain): string[] {
  const out: string[] = [];
  const problem = (text: string) => out.push(paint(`! ${text}`, 'red'));
  for (const t of tunnels) {
    if (t.state === 'failed' && t.error) {
      problem(`${t.label}: ${t.error.message}`);
      if (t.error.hint) out.push(fix(t.error.hint));
      continue;
    }
    if (t.state === 'missing') {
      problem(`${t.label}: the URL is gone from Cloudflare.`);
      out.push(fix('Run "everport up": it brings the tunnel back at the same address.'));
    } else if (t.health === 'unreachable') {
      problem(`${t.label}: cannot reach the public address.`);
      out.push(fix('Check your connection.'));
    } else if (t.state === 'active' && t.localDown) {
      // Not a problem of the tunnel: a note, like the one about old relay code.
      out.push(
        paint(`i ${t.label}: waiting for your app on ${shortTarget(t.target)}; start it to serve requests.`, 'dim'),
      );
    }
    if (t.outdated) {
      out.push(paint(`i ${t.label}: the relay on Cloudflare is from an older Everport. It still works.`, 'dim'));
    }
  }
  return out;
}

export function doctorLines(checks: DoctorCheck[], paint: Paint = plain): string[] {
  const out: string[] = [];
  for (const c of checks) {
    out.push(`${c.ok ? paint('OK  ', 'green') : paint('FAIL', 'red')}  ${c.name}: ${c.detail}`);
    if (!c.ok && c.hint) out.push(`    ${fix(c.hint)}`);
  }
  return out;
}

/**
 * Said after the very first tunnel: the public address holds the account's workers.dev subdomain, which
 * Cloudflare may have taken from the person's email when the account was made.
 */
export function subdomainNotice(url: string): string {
  const subdomain = new URL(url).hostname.split('.').at(-3) ?? '';
  return (
    `Note: your addresses are public and contain your Cloudflare workers.dev subdomain ("${subdomain}"), ` +
    'which Cloudflare may have taken from your email address. Check that you are happy with it before you share a link.'
  );
}
