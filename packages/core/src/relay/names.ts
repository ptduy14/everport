import { randomBytes } from 'node:crypto';
import { maxTunnelNameLength } from '../config-store.js';
import { EverportError } from '../errors.js';

export const defaultRandomHex = (bytes: number): string => randomBytes(bytes).toString('hex');

/**
 * Turns what a person typed into a name Cloudflare accepts: ASCII letters, digits and hyphens, no hyphen at
 * either end, short enough that `<name>-<worker>` stays a valid 63-character hostname label. Cloudflare rejects every
 * non-ASCII character with a confusing error (10003), so accents are stripped here, and a name that ends up empty
 * becomes a random one. The original text is kept by the caller as the tunnel's label.
 */
export function normalizeTunnelName(
  label: string,
  workerName: string,
  randomHex: (bytes: number) => string = defaultRandomHex,
): string {
  const max = maxTunnelNameLength(workerName);
  if (max < 1) {
    throw new EverportError(
      'INVALID_NAME',
      `The relay name "${workerName}" is too long to leave room for tunnel names`,
    );
  }
  const name = label
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, max)
    .replace(/-+$/g, '');
  if (name === '') return `t-${randomHex(2)}`.slice(0, max);
  // Cloudflare adds a random suffix to a preview named like a Worker of the account; doing it here saves a redeploy.
  if (name === workerName) return `${name.slice(0, Math.max(1, max - 5)).replace(/-+$/g, '')}-${randomHex(2)}`;
  return name;
}
