// Pure content of the "Add Tunnel" port picker (vscode-free, unit tested).
import { candidateTarget, normalizeTarget, type PortCandidate, type TunnelStatus } from '@everport/core';
import { targetError } from './ui-text.js';

export type PickEntry =
  | { kind: 'separator'; label: string }
  | { kind: 'candidate'; label: string; description: string; detail?: string; candidate: PortCandidate }
  | { kind: 'typed'; label: string; description: string; target: string }
  | { kind: 'showAll'; label: string }
  | { kind: 'manual'; label: string };

const GROUPS = [
  { group: 'workspace', title: 'This workspace', icon: 'folder' },
  { group: 'docker', title: 'Docker', icon: 'package' },
  { group: 'dev', title: 'Other dev servers', icon: 'server-process' },
  { group: 'other', title: 'Other listening ports', icon: 'plug' },
] as const;

export interface PickerState {
  /** null while the scan runs. */
  candidates: PortCandidate[] | null;
  showAll: boolean;
  typed: string;
  /** Local port → label of the tunnel that already shares it. */
  sharedNames?: ReadonlyMap<number, string>;
}

export function pickerEntries(s: PickerState): PickEntry[] {
  const out: PickEntry[] = [];
  const typed = s.typed.trim();
  const list = s.candidates ?? [];
  if (typed && !targetError(typed) && !list.some((c) => String(c.port) === typed)) {
    const target = normalizeTarget(typed);
    out.push({ kind: 'typed', label: `$(arrow-right) ${target}`, description: 'Use what you typed', target });
  }
  for (const g of GROUPS) {
    if (g.group === 'other' && !s.showAll) continue;
    const rows = list.filter((c) => c.group === g.group);
    if (!rows.length) continue;
    out.push({ kind: 'separator', label: g.title });
    for (const c of rows) {
      const name = s.sharedNames?.get(c.port);
      const shared = name ? `Already shared as "${name}"` : 'Already shared by a tunnel';
      const notes = [
        c.shared ? `${shared} · adding it again gives it a second URL` : '',
        c.http ? '' : "Doesn't answer HTTP · a web URL won't work for it",
      ].filter(Boolean);
      out.push({
        kind: 'candidate',
        label: `$(${g.icon}) ${c.port}`,
        description: c.label,
        ...(notes.length ? { detail: notes.join(' · ') } : {}),
        candidate: c,
      });
    }
  }
  const hiddenOthers = list.filter((c) => c.group === 'other').length;
  if (s.candidates && !s.showAll && hiddenOthers) {
    out.push({ kind: 'separator', label: '' });
    out.push({ kind: 'showAll', label: `$(list-unordered) Show all listening ports… (${hiddenOthers} more)` });
  }
  out.push({ kind: 'separator', label: '' });
  out.push({ kind: 'manual', label: '$(edit) Enter a port or URL…' });
  return out;
}

export function pickerPlaceholder(candidates: PortCandidate[] | null): string {
  if (!candidates) return 'Looking for running services… you can type a port or URL now';
  return candidates.some((c) => c.group !== 'hidden' && c.group !== 'other')
    ? 'Pick a running service, or type a port or URL'
    : 'No running dev servers found. Type a port or URL';
}

export const pickedTarget = (c: PortCandidate): string => candidateTarget(c);

/** Project or container name when free, then "<name>-<port>", then the port. */
export function suggestedLabel(c: PortCandidate, existing: TunnelStatus[]): string {
  const taken = (l: string) => existing.some((t) => t.label.toLowerCase() === l.toLowerCase());
  const options = c.project ? [c.project, `${c.project}-${c.port}`] : [];
  return options.find((l) => !taken(l)) ?? String(c.port);
}

const localPort = (t: TunnelStatus): number | undefined => {
  try {
    const u = new URL(t.target);
    const local = ['127.0.0.1', 'localhost', '[::1]', '0.0.0.0'].includes(u.hostname);
    return local ? Number(u.port || (u.protocol === 'https:' ? 443 : 80)) : undefined;
  } catch {
    return undefined;
  }
};

/** Local ports that already have a tunnel. */
export function sharedPorts(statuses: TunnelStatus[]): number[] {
  return statuses.flatMap((t) => {
    const port = localPort(t);
    return port === undefined ? [] : [port];
  });
}

/** Local port → label of the first tunnel that shares it. */
export function sharedNames(statuses: TunnelStatus[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const t of statuses) {
    const port = localPort(t);
    if (port !== undefined && !names.has(port)) names.set(port, t.label);
  }
  return names;
}
