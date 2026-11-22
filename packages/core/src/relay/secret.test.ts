import { describe, expect, it } from 'vitest';
import { createLayout } from '../paths.js';
import { FakeFs } from '../testing/fake-fs.js';
import { loadOrCreateRelaySecret } from './secret.js';

const layout = createLayout({ platform: 'linux', env: {}, home: '/h' }, '/data');

describe('loadOrCreateRelaySecret', () => {
  it('creates a 64-character secret on first use, in a private file', async () => {
    const fs = new FakeFs();
    const secret = await loadOrCreateRelaySecret(fs, layout, (bytes) => 'f'.repeat(bytes * 2));
    expect(secret).toBe('f'.repeat(64));
    expect(fs.text(layout.relaySecretFile)).toBe(`${secret}\n`);
    expect(fs.privatePaths.has(layout.relaySecretFile)).toBe(true);
  });

  it('keeps the secret it already has: replacing it would lock out every tunnel already deployed', async () => {
    const fs = new FakeFs().seed(layout.relaySecretFile, 'existing-secret\n');
    expect(await loadOrCreateRelaySecret(fs, layout, () => 'new')).toBe('existing-secret');
    expect(fs.text(layout.relaySecretFile)).toBe('existing-secret\n');
  });

  it('treats an empty file as no secret', async () => {
    const fs = new FakeFs().seed(layout.relaySecretFile, '\n');
    expect(await loadOrCreateRelaySecret(fs, layout, (bytes) => 'a'.repeat(bytes * 2))).toBe('a'.repeat(64));
  });

  it('is random by default: two fresh data directories get different secrets', async () => {
    const a = await loadOrCreateRelaySecret(new FakeFs(), layout);
    const b = await loadOrCreateRelaySecret(new FakeFs(), layout);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });
});
