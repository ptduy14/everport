import { describe, expect, it } from 'vitest';
import {
  ConfigStore,
  emptyConfig,
  findTunnel,
  maxTunnelNameLength,
  tunnelSchema,
  type Config,
  type Tunnel,
} from './config-store.js';
import { FakeFs } from './testing/fake-fs.js';

const FILE = '/d/tunnels.json';
const tunnel = (over: Partial<Tunnel> = {}): Tunnel => ({
  id: 'b3f1c2',
  label: 'Backend API',
  name: 'api',
  url: 'https://api-everport.me.workers.dev',
  target: 'http://127.0.0.1:3301',
  enabled: true,
  ...over,
});

describe('tunnel names', () => {
  it.each(['a', 'api', 'my-api-2', '0day'])('accepts %s', (name) => {
    expect(tunnelSchema.safeParse(tunnel({ name })).success).toBe(true);
  });

  it.each(['-api', 'api-', 'Api', 'my_api', 'café', '', 'a'.repeat(62)])('rejects %j', (name) => {
    expect(tunnelSchema.safeParse(tunnel({ name })).success).toBe(false);
  });

  it('shortens the limit by the worker name and the joining hyphen', () => {
    expect(maxTunnelNameLength('everport')).toBe(54);
  });
});

describe('ConfigStore.load', () => {
  it('returns an empty config when the file does not exist (and does not create it)', async () => {
    const fs = new FakeFs();
    expect(await new ConfigStore(fs, FILE).load()).toEqual(emptyConfig());
    expect(await fs.exists(FILE)).toBe(false);
  });

  it('reads a valid file', async () => {
    const fs = new FakeFs().seed(FILE, JSON.stringify({ ...emptyConfig(), tunnels: [tunnel()] }));
    expect((await new ConfigStore(fs, FILE).load()).tunnels).toEqual([tunnel()]);
  });

  it('reads a file saved with a UTF-8 BOM (Notepad, PowerShell 5.1)', async () => {
    const bom = String.fromCharCode(0xfeff);
    const fs = new FakeFs().seed(FILE, bom + JSON.stringify({ ...emptyConfig(), tunnels: [tunnel()] }));
    expect((await new ConfigStore(fs, FILE).load()).tunnels).toEqual([tunnel()]);
  });

  it.each([
    ['broken JSON', '{ nope'],
    ['no version', '{"tunnels":[]}'],
    ['future version', '{"version":99,"relay":null,"tunnels":[]}'],
    ['bad tunnel name', JSON.stringify({ ...emptyConfig(), tunnels: [tunnel({ name: 'Bad Name!' })] })],
    ['missing field', JSON.stringify({ ...emptyConfig(), tunnels: [{ id: 'x' }] })],
  ])('rejects %s with CONFIG_INVALID and leaves the file alone', async (_n, content) => {
    const fs = new FakeFs().seed(FILE, content);
    await expect(new ConfigStore(fs, FILE).load()).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(fs.text(FILE)).toBe(content);
  });

  it('says so when the file comes from the zrok-based Everport, and leaves it alone', async () => {
    const legacy = JSON.stringify({ version: 1, zrokVersion: '2.0.9', tunnels: [] });
    const fs = new FakeFs().seed(FILE, legacy);
    await expect(new ConfigStore(fs, FILE).load()).rejects.toMatchObject({
      code: 'CONFIG_INVALID',
      message: expect.stringContaining('older zrok-based Everport'),
      hint: expect.stringContaining('Rename or delete'),
    });
    expect(fs.text(FILE)).toBe(legacy);
  });
});

describe('ConfigStore.save', () => {
  it('writes through a temp file and leaves no temp behind', async () => {
    const fs = new FakeFs();
    const store = new ConfigStore(fs, FILE);
    await store.save({ ...emptyConfig(), tunnels: [tunnel()] });
    expect(JSON.parse(fs.text(FILE)!).tunnels).toHaveLength(1);
    expect([...fs.files.keys()]).toEqual([FILE]);
  });

  it('keeps the old file intact when the write fails', async () => {
    const fs = new FakeFs().seed(FILE, JSON.stringify(emptyConfig()));
    const before = fs.text(FILE);
    const store = new ConfigStore(fs, FILE);
    fs.writeText = async () => {
      throw new Error('disk full');
    };
    await expect(store.save({ ...emptyConfig(), tunnels: [tunnel()] })).rejects.toThrow('disk full');
    expect(fs.text(FILE)).toBe(before);
  });

  it('refuses to save an invalid config', async () => {
    const store = new ConfigStore(new FakeFs(), FILE);
    await expect(store.save({ ...emptyConfig(), tunnels: [tunnel({ name: 'X' })] })).rejects.toThrow();
  });
});

describe('ConfigStore.mutate', () => {
  it('applies concurrent updates one after another without losing any', async () => {
    const fs = new FakeFs();
    const store = new ConfigStore(fs, FILE);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        store.mutate((c: Config) => {
          c.tunnels.push(tunnel({ id: `id${i}`, label: `L${i}`, name: `name-${i}` }));
        }),
      ),
    );
    expect((await store.load()).tunnels.map((t) => t.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, i) => `id${i}`).sort(),
    );
  });

  it('does not save when the callback throws, and later updates still work', async () => {
    const fs = new FakeFs();
    const store = new ConfigStore(fs, FILE);
    await expect(
      store.mutate(() => {
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    expect(await fs.exists(FILE)).toBe(false);
    await store.mutate((c) => void c.tunnels.push(tunnel()));
    expect((await store.load()).tunnels).toHaveLength(1);
  });
});

describe('findTunnel', () => {
  const config: Config = {
    ...emptyConfig(),
    tunnels: [tunnel(), tunnel({ id: 'aaaaaa', label: 'Web', name: 'web' })],
  };

  it('finds by id or case-insensitive label', () => {
    expect(findTunnel(config, 'aaaaaa').label).toBe('Web');
    expect(findTunnel(config, 'backend api').id).toBe('b3f1c2');
  });

  it('throws TUNNEL_NOT_FOUND for unknown or ambiguous input', () => {
    expect(() => findTunnel(config, 'zzz')).toThrowError(expect.objectContaining({ code: 'TUNNEL_NOT_FOUND' }));
    const dup: Config = { ...config, tunnels: [...config.tunnels, tunnel({ id: 'cccccc', name: 'dup' })] };
    expect(() => findTunnel(dup, 'Backend API')).toThrowError(expect.objectContaining({ code: 'TUNNEL_NOT_FOUND' }));
  });
});
