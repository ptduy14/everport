import { EverportError } from './errors.js';
import type { FileSystem, ProcessTable } from './ports.js';

export type Release = () => Promise<void>;

/** Slack for the boot time, which is computed from the uptime and can move by a few seconds. */
const BOOT_SLACK_MS = 60_000;

/**
 * True when something recorded at `startedAt` was started before this computer last booted: its process is gone,
 * even if another process now has the same pid (Windows reuses pids quickly after a restart).
 */
export function startedBeforeBoot(startedAt: number | undefined, procs: ProcessTable): boolean {
  const boot = procs.bootTime?.();
  return startedAt !== undefined && boot !== undefined && startedAt < boot - BOOT_SLACK_MS;
}

/**
 * Exclusive lock file holding the owner's pid, so two Everport processes never heal or reconcile at once.
 * A lock whose owner is dead, or was written before the last restart, is taken over. Within one process the calls
 * are queued instead, so a second operation waits rather than finding its own pid in the lock.
 */
export class FileLock {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fs: FileSystem,
    private readonly procs: ProcessTable,
    private readonly file: string,
    private readonly pid: number,
    private readonly now: () => number = Date.now,
    private readonly wait: { ms: number; pollMs: number; sleep: (ms: number) => Promise<void> } = {
      ms: 60_000,
      pollMs: 250,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
  ) {}

  /** Takes the lock. While another live process holds it, waits up to a minute (an add takes about 20 s). */
  async acquire(): Promise<Release> {
    const deadline = this.now() + this.wait.ms;
    let takeovers = 0;
    for (;;) {
      const mine = JSON.stringify({ pid: this.pid, startedAt: this.now() });
      if (await this.fs.writeTextExclusive(this.file, mine)) {
        return async () => {
          await this.fs.remove(this.file);
        };
      }

      const content = await this.fs.readText(this.file);
      if (content === null) continue; // released between our two calls
      const owner = parseOwner(content);
      if (owner !== null && this.procs.isAlive(owner.pid) && !startedBeforeBoot(owner.startedAt, this.procs)) {
        if (this.now() < deadline) {
          await this.wait.sleep(this.wait.pollMs);
          continue;
        }
        throw new EverportError(
          'LOCKED',
          `Another Everport process (pid ${owner.pid}) is still working on the tunnels`,
          `Wait for it to finish, then try again. If no Everport is running, delete ${this.file}.`,
        );
      }
      // Owner is dead, from before a restart, or the file is garbage: take over, unless it was replaced meanwhile.
      if (++takeovers > 3) throw new EverportError('LOCKED', `Could not take the lock ${this.file}`, 'Try again.');
      if ((await this.fs.readText(this.file)) === content) await this.fs.remove(this.file);
    }
  }

  /** Runs `fn` holding the lock, after any call of this process that is still running. */
  withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await this.acquire();
      try {
        return await fn();
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

function parseOwner(content: string): { pid: number; startedAt?: number } | null {
  try {
    const { pid, startedAt } = JSON.parse(content) as { pid?: unknown; startedAt?: unknown };
    if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return null;
    return typeof startedAt === 'number' ? { pid, startedAt } : { pid };
  } catch {
    return null;
  }
}
