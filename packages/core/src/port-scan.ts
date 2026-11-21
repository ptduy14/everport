import { classifyPorts, type PortCandidate, type PortSnapshot } from './port-classifier.js';
import type { PortScanner } from './ports.js';

export interface ScanOptions {
  workspaceFolders: string[];
  /** Ports already used by a Everport tunnel. */
  sharedPorts?: number[];
}

/** The URL a tunnel to this candidate should use: the address it really listens on. */
export function candidateTarget(c: Pick<PortCandidate, 'address' | 'port'>): string {
  const a = c.address;
  if (a === '0.0.0.0' || a === '::' || a === '' || a === '127.0.0.1') return `http://127.0.0.1:${c.port}`;
  return a.includes(':') ? `http://[${a}]:${c.port}` : `http://${a}:${c.port}`;
}

/** Lists listening ports, classified for the picker; only shown candidates get an HTTP probe. */
export async function scanPorts(scanner: PortScanner, opts: ScanOptions): Promise<PortCandidate[]> {
  const dockerPromise = scanner.docker();
  const listeners = await scanner.listeners();
  const [processes, docker] = await Promise.all([
    scanner.processes([...new Set(listeners.map((l) => l.pid))]),
    dockerPromise,
  ]);
  const snapshot: PortSnapshot = {
    platform: scanner.platform,
    currentUser: scanner.currentUser(),
    workspaceFolders: opts.workspaceFolders,
    listeners,
    processes,
    docker,
    http: {},
  };
  const shown = classifyPorts(snapshot).filter((c) => c.group !== 'hidden');
  await Promise.all(
    shown.map(async (c) => {
      const host = new URL(candidateTarget(c)).hostname.replace(/^\[|\]$/g, '');
      snapshot.http[String(c.port)] = await scanner.probe(host, c.port);
    }),
  );
  return classifyPorts(snapshot, { sharedPorts: opts.sharedPorts ?? [] });
}
