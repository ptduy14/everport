import type { DoctorCheck, TunnelStatus } from '@everport/core';

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? '').length)));
  const line = (cells: string[]) =>
    cells
      .map((c, i) => c.padEnd(widths[i] ?? 0))
      .join('  ')
      .trimEnd();
  return [line(headers), line(widths.map((w) => '-'.repeat(w))), ...rows.map(line)].join('\n');
}

const STATE_TEXT: Record<TunnelStatus['state'], string> = {
  active: 'active',
  stopped: 'stopped',
  down: 'agent down',
  missing: 'preview gone',
  failed: 'FAILED',
};

export function tunnelTable(tunnels: TunnelStatus[]): string {
  if (tunnels.length === 0) return 'No tunnels yet. Add one with: everport add <port>';
  const withHealth = tunnels.some((t) => t.health !== undefined);
  const headers = ['ID', 'LABEL', 'URL', 'TARGET', 'STATE', ...(withHealth ? ['HEALTH'] : [])];
  const rows = tunnels.map((t) => [
    t.id,
    t.label,
    t.url,
    t.target,
    STATE_TEXT[t.state],
    ...(withHealth ? [t.health ?? '-'] : []),
  ]);
  return renderTable(headers, rows);
}

/** Problems worth a line under the table: failed tunnels and health findings, each with its fix. */
export function tunnelWarnings(tunnels: TunnelStatus[]): string[] {
  const out: string[] = [];
  for (const t of tunnels) {
    if (t.state === 'failed' && t.error) {
      out.push(`! ${t.label}: ${t.error.message}`);
      if (t.error.hint) out.push(`  ${t.error.hint}`);
      continue;
    }
    if (t.state === 'missing') {
      out.push(`! ${t.label}: the preview is gone from Cloudflare.`);
      out.push('  Run "everport up": it brings the tunnel back at the same address.');
    } else if (t.health === 'unreachable') {
      out.push(`! ${t.label}: cannot reach the public address. Check your connection.`);
    }
    if (t.outdated) {
      out.push(`i ${t.label}: the relay on Cloudflare runs older code than this version of Everport.`);
    }
  }
  return out;
}

export function doctorLines(checks: DoctorCheck[]): string[] {
  const out: string[] = [];
  for (const c of checks) {
    out.push(`${c.ok ? 'OK  ' : 'FAIL'}  ${c.name}: ${c.detail}`);
    if (!c.ok && c.hint) out.push(`      -> ${c.hint}`);
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
