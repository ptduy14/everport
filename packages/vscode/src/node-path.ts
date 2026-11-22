// Finds a real Node.js 22+ to run the agent and wrangler. Inside VS Code `process.execPath` is Electron, not Node.
// Pure: the probe is injected, so it is unit-tested without spawning anything.
import { EverportError } from '@everport/core';

export const MIN_NODE_MAJOR = 22;

/** Runs `<command> -p ...` and returns its stdout, or undefined when it cannot run. */
export type NodeProbe = (command: string, args: string[]) => Promise<string | undefined>;

/** The probe script prints the absolute path of the binary and its version, one per line. */
export const PROBE_ARGS = ['-p', "process.execPath + '\\n' + process.versions.node"];

export function parseProbe(stdout: string | undefined): { path: string; major: number } | undefined {
  const [path, version] = (stdout ?? '').trim().split(/\r?\n/);
  const major = Number(/^(\d+)\./.exec(version ?? '')?.[1]);
  return path && Number.isInteger(major) ? { path: path.trim(), major } : undefined;
}

/** `setting` is `everport.nodePath`; empty means the `node` on the PATH. */
export async function findNode(setting: string, probe: NodeProbe): Promise<string> {
  const command = setting.trim() || 'node';
  const found = parseProbe(await probe(command, PROBE_ARGS));
  if (!found) {
    throw new EverportError(
      'INTERNAL',
      setting.trim() ? `Could not run Node.js from "${command}"` : 'Node.js was not found on your PATH',
      'Install Node.js 22 or newer, or set "everport.nodePath" to the node executable.',
    );
  }
  if (found.major < MIN_NODE_MAJOR) {
    throw new EverportError(
      'INTERNAL',
      `Node.js ${found.major} is too old (${found.path})`,
      `Everport needs Node.js ${MIN_NODE_MAJOR} or newer. Install it or set "everport.nodePath".`,
    );
  }
  return found.path;
}
