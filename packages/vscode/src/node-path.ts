// Finds a real Node.js that wrangler runs on, to run the agent and wrangler. Inside VS Code `process.execPath` is
// Electron, not Node. Pure: the probe is injected, so it is unit-tested without spawning anything.
import { EverportError, MIN_NODE_LABEL, isSupportedNode } from '@everport/core';
import type { NodeCandidate } from './node-discovery.js';

/** Runs `<command> -p ...` and returns its stdout, or undefined when it cannot run. */
export type NodeProbe = (command: string, args: string[]) => Promise<string | undefined>;

/** The probe script prints the absolute path of the binary and its version, one per line. */
export const PROBE_ARGS = ['-p', "process.execPath + '\\n' + process.versions.node"];

/** Said whenever Node cannot be used: VS Code started from the Start menu, Dock or a launcher has no shell PATH. */
const HOW_TO_FIX =
  'Run "Everport: Select Node.js" to pick one, or set "everport.nodePath" (run "node -p process.execPath" in a terminal where the right Node.js is active).';

export function parseProbe(stdout: string | undefined): { path: string; version: string; major: number } | undefined {
  const [path, version] = (stdout ?? '').trim().split(/\r?\n/);
  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1]);
  return path && version && Number.isInteger(major) ? { path: path.trim(), version: version.trim(), major } : undefined;
}

/** Where the Node.js came from: the setting, the PATH, or a search of the usual places. */
export type NodeSource = 'setting' | 'path' | 'detected';
export interface NodeInfo extends NodeCandidate {
  source: NodeSource;
}

/**
 * `setting` is `everport.nodePath`. When it is set, only that Node.js is used and a problem with it is reported as is.
 * When it is empty, the `node` on the PATH is used; if there is none, or it is too old, `discover` looks in the
 * folders of the version managers and picks the newest Node.js that wrangler runs on.
 */
export async function findNodeInfo(
  setting: string,
  probe: NodeProbe,
  discover?: () => Promise<NodeCandidate[]>,
): Promise<NodeInfo> {
  const explicit = setting.trim();
  const command = explicit || 'node';
  const found = parseProbe(await probe(command, PROBE_ARGS));
  if (found && isSupportedNode(found.version)) {
    return { path: found.path, version: found.version, source: explicit ? 'setting' : 'path' };
  }
  if (!explicit && discover) {
    const best = (await discover())[0];
    if (best) return { ...best, source: 'detected' };
  }
  if (!found) {
    throw new EverportError(
      'INTERNAL',
      explicit ? `Could not run Node.js from "${command}"` : 'Node.js was not found on your PATH',
      `Install Node.js ${MIN_NODE_LABEL} or newer. ${HOW_TO_FIX}`,
    );
  }
  throw new EverportError(
    'INTERNAL',
    `Node.js ${found.version} is too old (${found.path})`,
    `Everport needs Node.js ${MIN_NODE_LABEL} or newer. ${HOW_TO_FIX}`,
  );
}

export async function findNode(
  setting: string,
  probe: NodeProbe,
  discover?: () => Promise<NodeCandidate[]>,
): Promise<string> {
  return (await findNodeInfo(setting, probe, discover)).path;
}
