import { promises as fsp } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { FileSystem } from '../ports.js';

const isCode = (e: unknown, code: string) => (e as NodeJS.ErrnoException | undefined)?.code === code;

export class NodeFileSystem implements FileSystem {
  async readText(path: string): Promise<string | null> {
    try {
      return await fsp.readFile(path, 'utf8');
    } catch (e) {
      if (isCode(e, 'ENOENT')) return null;
      throw e;
    }
  }

  async writeText(path: string, data: string): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, data, 'utf8');
  }

  async writeTextExclusive(path: string, data: string): Promise<boolean> {
    await fsp.mkdir(dirname(path), { recursive: true });
    try {
      await fsp.writeFile(path, data, { encoding: 'utf8', flag: 'wx' });
      return true;
    } catch (e) {
      if (isCode(e, 'EEXIST')) return false;
      throw e;
    }
  }

  async appendText(path: string, data: string): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.appendFile(path, data, 'utf8');
  }

  async rename(from: string, to: string): Promise<void> {
    await fsp.rename(from, to);
  }

  async remove(path: string): Promise<boolean> {
    try {
      await fsp.unlink(path);
      return true;
    } catch (e) {
      if (isCode(e, 'ENOENT')) return false;
      throw e;
    }
  }

  async exists(path: string): Promise<boolean> {
    try {
      await fsp.lstat(path);
      return true;
    } catch (e) {
      return !isCode(e, 'ENOENT');
    }
  }

  async size(path: string): Promise<number | null> {
    try {
      return (await fsp.stat(path)).size;
    } catch (e) {
      if (isCode(e, 'ENOENT')) return null;
      throw e;
    }
  }

  async writeBytes(path: string, data: Uint8Array): Promise<void> {
    await fsp.mkdir(dirname(path), { recursive: true });
    await fsp.writeFile(path, data);
  }

  async copyFile(from: string, to: string): Promise<void> {
    await fsp.mkdir(dirname(to), { recursive: true });
    await fsp.copyFile(from, to);
  }

  async chmodExecutable(path: string): Promise<void> {
    await fsp.chmod(path, 0o755);
  }

  makeTempDir(prefix: string): Promise<string> {
    return fsp.mkdtemp(join(tmpdir(), prefix));
  }

  async removeDir(path: string): Promise<void> {
    await fsp.rm(path, { recursive: true, force: true });
  }
}
