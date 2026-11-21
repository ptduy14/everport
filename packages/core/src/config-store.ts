import { z } from 'zod';
import { EverportError } from './errors.js';
import type { FileSystem } from './ports.js';

/** Lowercase letters, digits and hyphens; no leading or trailing hyphen (a DNS label). */
export const NAME_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** A hostname label holds 63 characters: `<name>-<worker>`. This bound assumes a one-character worker name. */
export const MAX_TUNNEL_NAME = 61;

/** Longest tunnel name that keeps `<name>-<worker>` a valid 63-character label. */
export const maxTunnelNameLength = (workerName: string): number => 63 - 1 - workerName.length;

export const relaySchema = z.object({
  workerName: z.string().min(1),
  /** The account's `workers.dev` subdomain. */
  subdomain: z.string().min(1),
  codeVersion: z.string().min(1),
  wranglerVersion: z.string().min(1),
});

export const tunnelSchema = z.object({
  id: z.string().min(1),
  /** The name the user typed. */
  label: z.string().min(1),
  /** The slug Cloudflare returned for the preview (part of the hostname). */
  name: z.string().min(1).max(MAX_TUNNEL_NAME).regex(NAME_PATTERN),
  /** The public URL read from `wrangler preview --json`, never computed. */
  url: z.string().url(),
  /** Normalized target URL, e.g. http://127.0.0.1:3000 */
  target: z.string().min(1),
  enabled: z.boolean(),
});

export const configSchema = z.object({
  version: z.literal(1),
  /** null until the first `add` creates the relay. */
  relay: relaySchema.nullable(),
  tunnels: z.array(tunnelSchema),
});

export type RelayConfig = z.infer<typeof relaySchema>;
export type Tunnel = z.infer<typeof tunnelSchema>;
export type Config = z.infer<typeof configSchema>;

export const CURRENT_CONFIG_VERSION = 1;

/** Drops a leading UTF-8 BOM (U+FEFF), which Notepad and PowerShell 5.1 write. */
export const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

export const emptyConfig = (): Config => ({ version: 1, relay: null, tunnels: [] });

/** Upgrades older config shapes step by step. Only v1 exists so far. */
export function migrate(raw: unknown, file: string): unknown {
  const version = (raw as { version?: unknown } | null)?.version;
  if (typeof version !== 'number') {
    throw new EverportError('CONFIG_INVALID', `${file} has no numeric "version"`, `Fix the file by hand or delete it.`);
  }
  if (version > CURRENT_CONFIG_VERSION) {
    throw new EverportError(
      'CONFIG_INVALID',
      `${file} was written by a newer Everport (config version ${version})`,
      'Upgrade everport.',
    );
  }
  return raw;
}

export class ConfigStore {
  private queue: Promise<unknown> = Promise.resolve();
  private tmpCounter = 0;

  constructor(
    private readonly fs: FileSystem,
    private readonly file: string,
  ) {}

  /** The stored config, or an empty one when nothing was saved yet. A broken file is an error, never overwritten. */
  async load(): Promise<Config> {
    const text = await this.fs.readText(this.file);
    if (text === null) return emptyConfig();
    let raw: unknown;
    try {
      raw = JSON.parse(stripBom(text));
    } catch {
      throw new EverportError('CONFIG_INVALID', `${this.file} is not valid JSON`, 'Fix the file by hand or delete it.');
    }
    const parsed = configSchema.safeParse(migrate(raw, this.file));
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      const where = first ? `${first.path.join('.') || '(root)'}: ${first.message}` : 'invalid';
      throw new EverportError(
        'CONFIG_INVALID',
        `${this.file} is invalid (${where})`,
        'Fix the file by hand or delete it.',
      );
    }
    return parsed.data;
  }

  /** Atomic: writes a temp file, then renames it over the real one. */
  async save(config: Config): Promise<void> {
    const valid = configSchema.parse(config);
    const tmp = `${this.file}.${Date.now().toString(36)}${(this.tmpCounter++).toString(36)}.tmp`;
    try {
      await this.fs.writeText(tmp, `${JSON.stringify(valid, null, 2)}\n`);
      await this.fs.rename(tmp, this.file);
    } catch (e) {
      await this.fs.remove(tmp).catch(() => {});
      throw e;
    }
  }

  /** Read-modify-write, serialized inside this process so concurrent updates never lose each other. */
  mutate<T>(fn: (config: Config) => T | Promise<T>): Promise<T> {
    const run = async () => {
      const config = await this.load();
      const result = await fn(config);
      await this.save(config);
      return result;
    };
    const next = this.queue.then(run, run);
    this.queue = next.catch(() => {});
    return next;
  }
}

/** Finds a tunnel by id, or by label (case-insensitive). */
export function findTunnel(config: Config, idOrLabel: string): Tunnel {
  const byId = config.tunnels.find((t) => t.id === idOrLabel);
  if (byId) return byId;
  const wanted = idOrLabel.toLowerCase();
  const byLabel = config.tunnels.filter((t) => t.label.toLowerCase() === wanted);
  if (byLabel.length === 1) return byLabel[0]!;
  if (byLabel.length > 1) {
    throw new EverportError('TUNNEL_NOT_FOUND', `"${idOrLabel}" matches several tunnels`, 'Use the tunnel id instead.');
  }
  throw new EverportError(
    'TUNNEL_NOT_FOUND',
    `No tunnel with id or label "${idOrLabel}"`,
    'Run "everport ls" to see your tunnels.',
  );
}
