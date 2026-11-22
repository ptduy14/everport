import { existsSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { EverportError } from '@everport/core';

export interface RuntimeFiles {
  /** The background agent, started with `node agent.js`. */
  agentEntry: string;
  /** The relay Worker that is deployed to Cloudflare. */
  workerFile: string;
}

/**
 * The agent and the Worker are built next to the CLI (dist/agent.js, dist/worker.js) and shipped in the same package,
 * so they are found beside the running CLI file.
 */
export function resolveRuntimeFiles(moduleUrl: string, exists: (path: string) => boolean = existsSync): RuntimeFiles {
  const dir = dirname(fileURLToPath(moduleUrl));
  const files = { agentEntry: join(dir, 'agent.js'), workerFile: join(dir, 'worker.js') };
  for (const file of Object.values(files)) {
    if (!exists(file)) {
      throw new EverportError(
        'INTERNAL',
        `Everport is incomplete: ${basename(file)} is missing from ${dir}`,
        'Reinstall everport.',
      );
    }
  }
  return files;
}
