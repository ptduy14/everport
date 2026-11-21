import { EverportError } from './errors.js';
import type { FileSystem, ProcessTable } from './ports.js';

export type Release = () => Promise<void>;

/**
 * Exclusive lock file holding the owner's pid, so two Everport processes never heal or reconcile at once.
 * A lock whose owner is dead is taken over.
 */
export class FileLock {
  constructor(
    private readonly fs: FileSystem,
    private readonly procs: ProcessTable,
    private readonly file: string,
    private readonly pid: number,
  ) {}

  async acquire(): Promise<Release> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (await this.fs.writeTextExclusive(this.file, JSON.stringify({ pid: this.pid }))) {
        return async () => {
          await this.fs.remove(this.file);
        };
      }

      const content = await this.fs.readText(this.file);
      if (content === null) continue; // released between our two calls
      const owner = parsePid(content);
      if (owner !== null && this.procs.isAlive(owner)) {
        throw new EverportError(
          'LOCKED',
          `Another Everport process (pid ${owner}) is working on the tunnels`,
          `Wait for it to finish. If no Everport is running, delete ${this.file}.`,
        );
      }
      // Owner is dead or the file is garbage: take over, but only if nobody replaced it meanwhile.
      if ((await this.fs.readText(this.file)) === content) await this.fs.remove(this.file);
    }
    throw new EverportError('LOCKED', `Could not take the lock ${this.file}`, 'Try again.');
  }

  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    const release = await this.acquire();
    try {
      return await fn();
    } finally {
      await release();
    }
  }
}

function parsePid(content: string): number | null {
  try {
    const pid = (JSON.parse(content) as { pid?: unknown }).pid;
    return typeof pid === 'number' && Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}
