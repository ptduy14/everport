import type { FileSystem } from './ports.js';

export interface Logger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export const nullLogger: Logger = { info() {}, warn() {}, error() {} };

export interface FileLoggerOptions {
  maxBytes?: number;
  /** Number of rotated files to keep (everport.log.1 ... everport.log.<keep>). */
  keep?: number;
  now?: () => Date;
}

/** Appends lines to a file and rotates it by size. Writes are serialized; failures never throw. */
export class FileLogger implements Logger {
  private queue: Promise<void> = Promise.resolve();
  private readonly maxBytes: number;
  private readonly keep: number;
  private readonly now: () => Date;

  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
    opts: FileLoggerOptions = {},
  ) {
    this.maxBytes = opts.maxBytes ?? 1_000_000;
    this.keep = opts.keep ?? 3;
    this.now = opts.now ?? (() => new Date());
  }

  info(msg: string): void {
    this.write('INFO', msg);
  }
  warn(msg: string): void {
    this.write('WARN', msg);
  }
  error(msg: string): void {
    this.write('ERROR', msg);
  }

  /** Resolves when everything logged so far is on disk. */
  flush(): Promise<void> {
    return this.queue;
  }

  private write(level: string, msg: string): void {
    const line = `${this.now().toISOString()} ${level} ${msg}\n`;
    this.queue = this.queue.then(() => this.append(line)).catch(() => {});
  }

  private async append(line: string): Promise<void> {
    const size = await this.fs.size(this.file);
    if (size !== null && size + line.length > this.maxBytes) await this.rotate();
    await this.fs.appendText(this.file, line);
  }

  private async rotate(): Promise<void> {
    await this.fs.remove(`${this.file}.${this.keep}`);
    for (let i = this.keep - 1; i >= 1; i--) {
      if (await this.fs.exists(`${this.file}.${i}`)) await this.fs.rename(`${this.file}.${i}`, `${this.file}.${i + 1}`);
    }
    await this.fs.rename(this.file, `${this.file}.1`);
  }
}
