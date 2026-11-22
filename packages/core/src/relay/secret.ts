import type { Layout } from '../paths.js';
import type { FileSystem } from '../ports.js';
import { defaultRandomHex } from './names.js';

/**
 * The relay secret: one per Worker, in its own file readable by the owner only. Created the first time it
 * is needed and then kept: replacing it would lock out every tunnel already deployed with the old one.
 */
export async function loadOrCreateRelaySecret(
  fs: FileSystem,
  layout: Layout,
  randomHex: (bytes: number) => string = defaultRandomHex,
): Promise<string> {
  const existing = (await fs.readText(layout.relaySecretFile))?.trim();
  if (existing) return existing;
  const secret = randomHex(32);
  await fs.writeTextPrivate(layout.relaySecretFile, `${secret}\n`);
  return secret;
}
