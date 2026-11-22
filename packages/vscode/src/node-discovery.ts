// Finds Node.js installs that VS Code's own PATH may not show: the folders of fnm, nvm, Volta and asdf, and the usual
// system places. Pure: the file system and the probe are injected, so it is unit-tested without touching the disk.
import { posix, win32 } from 'node:path';
import { isSupportedNode } from '@everport/core';

export interface NodeCandidate {
  path: string;
  version: string;
}

export interface DiscoveryHost {
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  home: string;
  /** Names of the folders inside `dir`; empty when it does not exist. */
  subfolders(dir: string): Promise<string[]>;
  exists(path: string): Promise<boolean>;
}

/** How many of the newest versions of each manager are tried. */
const NEWEST_PER_MANAGER = 6;

const numbers = (text: string): number[] | undefined => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : undefined;
};

/** Newest first; folder names without a version go last. */
export function compareVersionsDesc(a: string, b: string): number {
  const [x, y] = [numbers(a), numbers(b)];
  if (!x || !y) return x ? -1 : y ? 1 : 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (y[i] ?? 0) - (x[i] ?? 0);
  return 0;
}

/** Where a node binary could be, without running anything. Not all of these exist. */
export async function candidatePaths(host: DiscoveryHost): Promise<string[]> {
  const win = host.platform === 'win32';
  const { join } = win ? win32 : posix;
  const { env, home } = host;

  // A manager keeps one folder per version: `versionsDir/<version>/<tail>`.
  const managers: { versionsDir: string; tail: string[] }[] = win
    ? [
        {
          versionsDir: join(
            env['FNM_DIR'] ?? join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'fnm'),
            'node-versions',
          ),
          tail: ['installation', 'node.exe'],
        },
        {
          versionsDir: join(
            env['VOLTA_HOME'] ?? join(env['LOCALAPPDATA'] ?? join(home, 'AppData', 'Local'), 'Volta'),
            'tools',
            'image',
            'node',
          ),
          tail: ['node.exe'],
        },
        {
          versionsDir: env['NVM_HOME'] ?? join(env['APPDATA'] ?? join(home, 'AppData', 'Roaming'), 'nvm'),
          tail: ['node.exe'],
        },
      ]
    : [
        {
          versionsDir: join(env['FNM_DIR'] ?? join(home, '.local', 'share', 'fnm'), 'node-versions'),
          tail: ['installation', 'bin', 'node'],
        },
        ...(host.platform === 'darwin' && !env['FNM_DIR']
          ? [
              {
                versionsDir: join(home, 'Library', 'Application Support', 'fnm', 'node-versions'),
                tail: ['installation', 'bin', 'node'],
              },
            ]
          : []),
        { versionsDir: join(env['NVM_DIR'] ?? join(home, '.nvm'), 'versions', 'node'), tail: ['bin', 'node'] },
        {
          versionsDir: join(env['VOLTA_HOME'] ?? join(home, '.volta'), 'tools', 'image', 'node'),
          tail: ['bin', 'node'],
        },
        { versionsDir: join(env['ASDF_DATA_DIR'] ?? join(home, '.asdf'), 'installs', 'nodejs'), tail: ['bin', 'node'] },
      ];

  const found: string[] = [];
  for (const { versionsDir, tail } of managers) {
    const names = (await host.subfolders(versionsDir)).sort(compareVersionsDesc).slice(0, NEWEST_PER_MANAGER);
    found.push(...names.map((name) => join(versionsDir, name, ...tail)));
  }
  found.push(
    ...(win
      ? [join(env['ProgramFiles'] ?? 'C:\\Program Files', 'nodejs', 'node.exe')]
      : ['/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node']),
  );

  const existing: string[] = [];
  for (const path of new Set(found)) if (await host.exists(path)) existing.push(path);
  return existing;
}

/** Runs each candidate and returns the ones that are new enough, newest first. */
export async function discoverNodes(
  host: DiscoveryHost,
  probe: (path: string) => Promise<NodeCandidate | undefined>,
): Promise<NodeCandidate[]> {
  const probed = await Promise.all((await candidatePaths(host)).map((path) => probe(path)));
  const usable = probed.filter((c): c is NodeCandidate => c !== undefined && isSupportedNode(c.version));
  const seen = new Set<string>();
  return usable
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
    .filter((c) => (seen.has(c.path) ? false : (seen.add(c.path), true)));
}
