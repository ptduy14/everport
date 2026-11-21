import type { FileSystem } from '../ports.js';

/** In-memory FileSystem for unit tests. Paths are opaque strings. */
export class FakeFs implements FileSystem {
  files = new Map<string, string | Uint8Array>();
  /** Makes write calls to these paths fail, to simulate IO errors. */
  failWrites = new Set<string>();
  private tempCounter = 0;

  seed(path: string, data: string | Uint8Array): this {
    this.files.set(path, data);
    return this;
  }

  text(path: string): string | undefined {
    const v = this.files.get(path);
    return typeof v === 'string' ? v : v ? new TextDecoder().decode(v) : undefined;
  }

  async readText(path: string): Promise<string | null> {
    return this.text(path) ?? null;
  }

  async writeText(path: string, data: string): Promise<void> {
    this.guard(path);
    this.files.set(path, data);
  }

  async writeTextExclusive(path: string, data: string): Promise<boolean> {
    if (this.files.has(path)) return false;
    this.files.set(path, data);
    return true;
  }

  async appendText(path: string, data: string): Promise<void> {
    this.files.set(path, (this.text(path) ?? '') + data);
  }

  async rename(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.guard(to);
    this.files.delete(from);
    this.files.set(to, v);
  }

  async remove(path: string): Promise<boolean> {
    return this.files.delete(path);
  }

  async exists(path: string): Promise<boolean> {
    return this.files.has(path);
  }

  async size(path: string): Promise<number | null> {
    const v = this.files.get(path);
    return v === undefined ? null : typeof v === 'string' ? v.length : v.length;
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    this.files.set(path, data);
  }

  async copyFile(from: string, to: string): Promise<void> {
    const v = this.files.get(from);
    if (v === undefined) throw new Error(`ENOENT: ${from}`);
    this.files.set(to, v);
  }

  async chmodExecutable(): Promise<void> {}

  async makeTempDir(prefix: string): Promise<string> {
    return `/tmp/${prefix}${++this.tempCounter}`;
  }

  async removeDir(path: string): Promise<void> {
    for (const k of [...this.files.keys()]) if (k.startsWith(`${path}/`)) this.files.delete(k);
  }

  private guard(path: string): void {
    if (this.failWrites.has(path)) throw new Error(`EIO: cannot write ${path}`);
  }
}
