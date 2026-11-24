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
  /** With `detected`: the Node.js on the PATH that was too old, if there was one. */
  skipped?: NodeCandidate;
}

/** missing: no Node.js on the PATH; broken: the given path does not run; old: it runs but is too old. */
export type NodeProblem = 'missing' | 'broken' | 'old';

export class NodeUnusableError extends EverportError {
  constructor(
    readonly problem: NodeProblem,
    readonly found: NodeCandidate | undefined,
    message: string,
    hint: string,
  ) {
    super('INTERNAL', message, hint);
  }
}

/** One sentence above the view: why Everport cannot run. Paths and tips go to the log. */
export function nodeProblemText(e: NodeUnusableError): string {
  if (e.problem === 'old' && e.found)
    return `Found Node.js ${e.found.version}, but Everport needs ${MIN_NODE_LABEL} or newer.`;
  return e.problem === 'broken'
    ? "The Node.js set in Settings couldn't run."
    : "Node.js wasn't found on this computer.";
}

/** Why a file picked in "Select Node.js" cannot be used. */
export function pickedNodeText(e: NodeUnusableError): string {
  return e.problem === 'old' && e.found
    ? `That's Node.js ${e.found.version}. Everport needs ${MIN_NODE_LABEL} or newer.`
    : "That file isn't Node.js. Pick the node executable (node.exe on Windows).";
}

/** The version manager a Node.js comes from, guessed from its path. */
export function nodeOrigin(path: string): string {
  const p = path.toLowerCase();
  if (/[\\/]fnm[\\/]/.test(p) || p.includes('fnm_multishells')) return 'fnm';
  if (/[\\/]\.?nvm[\\/]|nvm4w|[\\/]nvm-windows[\\/]/.test(p)) return 'nvm';
  if (/[\\/]\.?volta[\\/]/.test(p)) return 'Volta';
  if (/[\\/]\.?asdf[\\/]/.test(p)) return 'asdf';
  return 'system';
}

/** Log line for a Node.js Everport picked by itself. */
export function detectedNote(info: NodeInfo): string {
  const where = `Node.js ${info.version} from ${nodeOrigin(info.path)} (${info.path})`;
  return info.skipped
    ? `Your PATH has Node.js ${info.skipped.version}, which is too old, so Everport uses ${where}.`
    : `No Node.js on your PATH, so Everport uses ${where}.`;
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
    if (best)
      return { ...best, source: 'detected', ...(found && { skipped: { path: found.path, version: found.version } }) };
  }
  if (!found) {
    throw new NodeUnusableError(
      explicit ? 'broken' : 'missing',
      undefined,
      explicit ? `Could not run Node.js from "${command}"` : 'Node.js was not found on your PATH',
      `Install Node.js ${MIN_NODE_LABEL} or newer. ${HOW_TO_FIX}`,
    );
  }
  throw new NodeUnusableError(
    'old',
    { path: found.path, version: found.version },
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

export type NodePickEntry =
  | { kind: 'separator'; label: string }
  | { kind: 'use'; label: string; description: string; detail: string; path: string; inUse: boolean }
  | { kind: 'browse'; label: string }
  | { kind: 'auto'; label: string; description: string; detail: string };

const samePath = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * "Select Node.js": the installs found (newest first, the one in use marked), a file to browse to, and the automatic
 * choice. `pathNode` is the node on the PATH, which the automatic choice tries first.
 */
export function nodePickEntries(
  found: NodeCandidate[],
  inUse: string | undefined,
  pathNode: NodeCandidate | undefined,
): NodePickEntry[] {
  const out: NodePickEntry[] = [];
  if (found.length) out.push({ kind: 'separator', label: 'found on this computer' });
  for (const n of found) {
    const using = !!inUse && samePath(n.path, inUse);
    out.push({
      kind: 'use',
      label: `${using ? '$(check)' : '$(blank)'} Node.js ${n.version}`,
      description: [nodeOrigin(n.path), using ? 'in use' : ''].filter(Boolean).join(' · '),
      detail: n.path,
      path: n.path,
      inUse: using,
    });
  }
  out.push({ kind: 'separator', label: 'other' });
  out.push({ kind: 'browse', label: '$(folder-opened) Browse for node…' });
  const onPath = pathNode
    ? `now Node.js ${pathNode.version}${isSupportedNode(pathNode.version) ? '' : ', too old'}`
    : 'none there now';
  out.push({
    kind: 'auto',
    label: '$(sparkle) Pick automatically',
    description: 'clears the setting',
    detail: `PATH first (${onPath}), then the newest found`,
  });
  return out;
}
