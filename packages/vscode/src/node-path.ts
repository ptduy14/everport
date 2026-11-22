// Finds a real Node.js that wrangler runs on, to run the agent and wrangler. Inside VS Code `process.execPath` is
// Electron, not Node. Pure: the probe is injected, so it is unit-tested without spawning anything.
import { EverportError, MIN_NODE_LABEL, isSupportedNode } from '@everport/core';

/** Runs `<command> -p ...` and returns its stdout, or undefined when it cannot run. */
export type NodeProbe = (command: string, args: string[]) => Promise<string | undefined>;

/** The probe script prints the absolute path of the binary and its version, one per line. */
export const PROBE_ARGS = ['-p', "process.execPath + '\n' + process.versions.node"];

/** Said whenever Node cannot be used: VS Code started from the Start menu, Dock or a launcher has no shell PATH. */
const MANAGER_HINT =
  'With a version manager (fnm, nvm, Volta) VS Code may not see your shell\'s PATH: run "node -p process.execPath" in a terminal where the right Node is active and set "everport.nodePath" to the result.';

export function parseProbe(stdout: string | undefined): { path: string; version: string; major: number } | undefined {
  const [path, version] = (stdout ?? '').trim().split(/\r?\n/);
  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1]);
  return path && version && Number.isInteger(major) ? { path: path.trim(), version: version.trim(), major } : undefined;
}

/** `setting` is `everport.nodePath`; empty means the `node` on the PATH. */
export async function findNodeInfo(setting: string, probe: NodeProbe): Promise<{ path: string; version: string }> {
  const command = setting.trim() || 'node';
  const found = parseProbe(await probe(command, PROBE_ARGS));
  if (!found) {
    throw new EverportError(
      'INTERNAL',
      setting.trim() ? `Could not run Node.js from "${command}"` : 'Node.js was not found on your PATH',
      `Install Node.js ${MIN_NODE_LABEL} or newer, or set "everport.nodePath" to the node executable. ${MANAGER_HINT}`,
    );
  }
  if (!isSupportedNode(found.version)) {
    throw new EverportError(
      'INTERNAL',
      `Node.js ${found.version} is too old (${found.path})`,
      `Everport needs Node.js ${MIN_NODE_LABEL} or newer. Install it or set "everport.nodePath". ${MANAGER_HINT}`,
    );
  }
  return { path: found.path, version: found.version };
}

export async function findNode(setting: string, probe: NodeProbe): Promise<string> {
  return (await findNodeInfo(setting, probe)).path;
}
