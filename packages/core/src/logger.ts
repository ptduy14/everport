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

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** Local time with its UTC offset, `2026-11-23 20:14:03.512 +07:00`: readable, and still one exact instant. */
export function localStamp(d: Date): string {
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${date} ${time} ${sign}${pad(Math.floor(Math.abs(off) / 60))}:${pad(Math.abs(off) % 60)}`;
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
    const line = `${localStamp(this.now())} ${level} ${msg}\n`;
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
