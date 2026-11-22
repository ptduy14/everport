import { describe, expect, it } from 'vitest';
import { candidatePaths, compareVersionsDesc, discoverNodes, type DiscoveryHost } from './node-discovery.js';

/** A fake disk: `files` are the paths that exist, `folders` maps a folder to the names inside it. */
const host = (
  platform: NodeJS.Platform,
  files: string[],
  folders: Record<string, string[]>,
  env: NodeJS.ProcessEnv = {},
  home = platform === 'win32' ? 'C:\\Users\\a' : '/home/a',
): DiscoveryHost => ({
  platform,
  env,
  home,
  subfolders: async (dir) => folders[dir] ?? [],
  exists: async (path) => files.includes(path),
});

describe('compareVersionsDesc', () => {
  it('puts the newest first and compares numbers, not text', () => {
    expect(['v22.9.0', 'v24.22.3', 'v22.12.0', 'v100.0.0'].sort(compareVersionsDesc)).toEqual([
      'v100.0.0',
      'v24.22.3',
      'v22.12.0',
      'v22.9.0',
    ]);
  });
  it('puts names without a version last', () => {
    expect(['alias', 'v20.1.0'].sort(compareVersionsDesc)).toEqual(['v20.1.0', 'alias']);
  });
});

describe('candidatePaths', () => {
  it('finds fnm, nvm and Volta installs on Linux and skips what is not on disk', async () => {
    const files = [
      '/home/a/.local/share/fnm/node-versions/v24.22.3/installation/bin/node',
      '/home/a/.nvm/versions/node/v22.12.0/bin/node',
      '/home/a/.volta/tools/image/node/22.14.0/bin/node',
    ];
    const folders = {
      '/home/a/.local/share/fnm/node-versions': ['v24.22.3', 'v20.1.0'],
      '/home/a/.nvm/versions/node': ['v22.12.0'],
      '/home/a/.volta/tools/image/node': ['22.14.0'],
    };
    expect(await candidatePaths(host('linux', files, folders))).toEqual(files);
  });

  it('finds fnm and Volta on Windows with their folders under the user profile', async () => {
    const fnm = 'C:\\Users\\a\\AppData\\Roaming\\fnm\\node-versions\\v24.22.3\\installation\\node.exe';
    const volta = 'C:\\Users\\a\\AppData\\Local\\Volta\\tools\\image\\node\\22.14.0\\node.exe';
    const folders = {
      'C:\\Users\\a\\AppData\\Roaming\\fnm\\node-versions': ['v24.22.3'],
      'C:\\Users\\a\\AppData\\Local\\Volta\\tools\\image\\node': ['22.14.0'],
    };
    expect(await candidatePaths(host('win32', [fnm, volta], folders))).toEqual([fnm, volta]);
  });

  it('honours the managers own folder variables', async () => {
    const nvm = '/data/nvm/versions/node/v22.12.0/bin/node';
    const found = await candidatePaths(
      host('linux', [nvm], { '/data/nvm/versions/node': ['v22.12.0'] }, { NVM_DIR: '/data/nvm' }),
    );
    expect(found).toEqual([nvm]);
  });

  it('also looks in the fnm folder of macOS and the Homebrew folders', async () => {
    const fnm = '/home/a/Library/Application Support/fnm/node-versions/v24.1.0/installation/bin/node';
    const brew = '/opt/homebrew/bin/node';
    const folders = { '/home/a/Library/Application Support/fnm/node-versions': ['v24.1.0'] };
    expect(await candidatePaths(host('darwin', [fnm, brew], folders))).toEqual([fnm, brew]);
  });

  it('tries only the newest versions of a manager', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `v22.${i}.0`);
    const dir = '/home/a/.nvm/versions/node';
    const files = names.map((n) => `${dir}/${n}/bin/node`);
    const found = await candidatePaths(host('linux', files, { [dir]: names }));
    expect(found).toHaveLength(6);
    expect(found[0]).toContain('v22.11.0');
  });
});

describe('discoverNodes', () => {
  it('drops versions below 22.12, drops binaries that do not run, and sorts newest first', async () => {
    const withFiles: DiscoveryHost = {
      ...host('linux', [], {}),
      subfolders: async (dir) => (dir === '/home/a/.nvm/versions/node' ? ['a', 'b', 'c'] : []),
      exists: async (path) => path.startsWith('/home/a/.nvm/') || path === '/usr/bin/node',
    };
    const probed: Record<string, string | undefined> = {
      '/home/a/.nvm/versions/node/a/bin/node': '22.11.0',
      '/home/a/.nvm/versions/node/b/bin/node': '24.22.3',
      '/home/a/.nvm/versions/node/c/bin/node': '22.12.1',
      '/usr/bin/node': undefined,
    };
    const all = await discoverNodes(withFiles, async (path) => {
      const version = probed[path];
      return version ? { path, version } : undefined;
    });
    expect(all.map((n) => n.version)).toEqual(['24.22.3', '22.12.1']);
  });
});
