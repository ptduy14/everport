import { execFileSync } from 'node:child_process';
import { EverportError } from '@everport/core';
import { describe, expect, it } from 'vitest';
import {
  PROBE_ARGS,
  detectedNote,
  findNode,
  findNodeInfo,
  nodeOrigin,
  nodePickEntries,
  nodeProblemText,
  parseProbe,
  pickedNodeText,
  type NodeUnusableError,
} from './node-path.js';

describe('parseProbe', () => {
  it('reads the path, the version and the major version', () => {
    expect(parseProbe('C:\\node\\node.exe\r\n24.22.3\r\n')).toEqual({
      path: 'C:\\node\\node.exe',
      version: '24.22.3',
      major: 24,
    });
    expect(parseProbe('/usr/bin/node\n22.1.0\n')).toEqual({ path: '/usr/bin/node', version: '22.1.0', major: 22 });
  });
  it.each([undefined, '', 'only-a-path', '/usr/bin/node\nnot-a-version'])('rejects %j', (out) => {
    expect(parseProbe(out)).toBeUndefined();
  });
});

describe('findNode', () => {
  it('uses `node` from the PATH when the setting is empty, and returns the real binary path', async () => {
    const calls: [string, string[]][] = [];
    const path = await findNode('', async (cmd, args) => {
      calls.push([cmd, args]);
      return '/opt/node/bin/node\n24.0.0\n';
    });
    expect(path).toBe('/opt/node/bin/node');
    expect(calls).toEqual([['node', PROBE_ARGS]]);
  });

  it('uses the configured path', async () => {
    const seen: string[] = [];
    await findNode('  /custom/node ', async (cmd) => (seen.push(cmd), '/custom/node\n22.12.0\n'));
    expect(seen).toEqual(['/custom/node']);
  });

  it('says how to fix a missing Node', async () => {
    const error = await findNode('', async () => undefined).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EverportError);
    expect((error as EverportError).message).toContain('not found on your PATH');
    expect((error as EverportError).hint).toContain('everport.nodePath');
    const custom = await findNode('/nope', async () => undefined).catch((e: unknown) => e);
    expect((custom as EverportError).message).toContain('"/nope"');
  });

  it('refuses a Node older than 22', async () => {
    const error = await findNode('', async () => '/old/node\n20.19.4\n').catch((e: unknown) => e);
    expect((error as EverportError).message).toContain('Node.js 20.19.4 is too old');
    expect((error as EverportError).hint).toContain('22.12');
  });

  it('refuses a Node 22 below 22.12, which wrangler cannot run on, and accepts 22.12', async () => {
    const old = await findNode('', async () => '/n/node\n22.11.0\n').catch((e: unknown) => e);
    expect((old as EverportError).message).toContain('Node.js 22.11.0 is too old');
    expect(await findNode('', async () => '/n/node\n22.12.0\n')).toBe('/n/node');
  });

  it('tells people who use a version manager how to find the path to give VS Code', async () => {
    const error = await findNode('', async () => undefined).catch((e: unknown) => e);
    expect((error as EverportError).hint).toContain('process.execPath');
  });

  it('returns the version too, so the doctor can report the Node that will run wrangler', async () => {
    expect(await findNodeInfo('', async () => '/n/node\n24.22.3\n')).toEqual({
      path: '/n/node',
      version: '24.22.3',
      source: 'path',
    });
  });
});

describe('the probe script', () => {
  it('really runs on Node and its output is understood (a broken script made every Node look missing)', () => {
    const out = execFileSync(process.execPath, PROBE_ARGS, { encoding: 'utf8' });
    expect(parseProbe(out)).toMatchObject({ path: process.execPath, version: process.versions.node });
  });
});

describe('findNodeInfo with a search of the usual places', () => {
  const found = [{ path: '/n/24/bin/node', version: '24.22.3' }];

  it('uses the node on the PATH first and does not search', async () => {
    let searched = false;
    const info = await findNodeInfo(
      '',
      async () => '/usr/bin/node\n22.14.0\n',
      async () => ((searched = true), found),
    );
    expect(info).toEqual({ path: '/usr/bin/node', version: '22.14.0', source: 'path' });
    expect(searched).toBe(false);
  });

  it('searches when there is no node on the PATH', async () => {
    const info = await findNodeInfo(
      '',
      async () => undefined,
      async () => found,
    );
    expect(info).toEqual({ path: '/n/24/bin/node', version: '24.22.3', source: 'detected' });
  });

  it('searches when the node on the PATH is too old (VS Code started without the version manager)', async () => {
    const info = await findNodeInfo(
      '',
      async () => '/usr/bin/node\n20.19.4\n',
      async () => found,
    );
    expect(info.source).toBe('detected');
    expect(info.version).toBe('24.22.3');
  });

  it('keeps the explanation when the search finds nothing', async () => {
    const error = await findNodeInfo(
      '',
      async () => '/usr/bin/node\n20.19.4\n',
      async () => [],
    ).catch((e: unknown) => e);
    expect((error as EverportError).message).toContain('Node.js 20.19.4 is too old');
  });

  it('never replaces a path the person chose: a setting that fails is reported as it is', async () => {
    let searched = false;
    const error = await findNodeInfo(
      '/mine/node',
      async () => undefined,
      async () => ((searched = true), found),
    ).catch((e: unknown) => e);
    expect((error as EverportError).message).toContain('Could not run Node.js from "/mine/node"');
    expect(searched).toBe(false);
  });

  it('points at the command that picks a Node.js', async () => {
    const error = await findNodeInfo('', async () => undefined).catch((e: unknown) => e);
    expect((error as EverportError).hint).toContain('Everport: Select Node.js');
  });
});

describe('what the person reads about Node.js', () => {
  const failure = (run: Promise<unknown>): Promise<NodeUnusableError> =>
    run.then(
      () => {
        throw new Error('expected Node.js to be unusable');
      },
      (e: unknown) => e as NodeUnusableError,
    );
  const tooOld = () =>
    failure(
      findNodeInfo(
        '',
        async () => '/usr/bin/node\n20.19.4\n',
        async () => [],
      ),
    );

  it('says in one sentence why Node.js cannot be used', async () => {
    expect(nodeProblemText(await tooOld())).toBe('Found Node.js 20.19.4, but Everport needs 22.12 or newer.');
    const missing = await failure(findNodeInfo('', async () => undefined));
    expect(nodeProblemText(missing)).toBe("Node.js wasn't found on this computer.");
    const broken = await failure(findNodeInfo('/mine/node', async () => undefined));
    expect(nodeProblemText(broken)).toBe("The Node.js set in Settings couldn't run.");
  });

  it('says what a picked file is when it cannot be used', async () => {
    expect(pickedNodeText(await tooOld())).toBe("That's Node.js 20.19.4. Everport needs 22.12 or newer.");
    const broken = await failure(findNodeInfo('C:\\x\\notepad.exe', async () => undefined));
    expect(pickedNodeText(broken)).toContain("That file isn't Node.js");
  });

  it('remembers the PATH node it skipped, and explains the choice', async () => {
    const info = await findNodeInfo(
      '',
      async () => '/usr/bin/node\n20.19.4\n',
      async () => [{ path: '/home/me/.nvm/versions/node/v24.22.3/bin/node', version: '24.22.3' }],
    );
    expect(info.skipped).toEqual({ path: '/usr/bin/node', version: '20.19.4' });
    expect(detectedNote(info)).toBe(
      'Your PATH has Node.js 20.19.4, which is too old, so Everport uses Node.js 24.22.3 from nvm (/home/me/.nvm/versions/node/v24.22.3/bin/node).',
    );
  });

  it.each([
    ['C:\\Users\\me\\AppData\\Roaming\\fnm\\node-versions\\v24.22.3\\installation\\node.exe', 'fnm'],
    ['/home/me/.nvm/versions/node/v22.14.0/bin/node', 'nvm'],
    ['C:\\nvm4w\\nodejs\\node.exe', 'nvm'],
    ['/home/me/.volta/tools/image/node/24.0.0/bin/node', 'Volta'],
    ['/home/me/.asdf/installs/nodejs/22.12.0/bin/node', 'asdf'],
    ['C:\\Program Files\\nodejs\\node.exe', 'system'],
  ])('names where %s comes from', (path, origin) => {
    expect(nodeOrigin(path)).toBe(origin);
  });
});

describe('nodePickEntries', () => {
  const found = [
    { path: 'C:\\fnm\\v24\\node.exe', version: '24.22.3' },
    { path: 'C:\\fnm\\v22\\node.exe', version: '22.23.5' },
  ];

  it('marks the Node.js in use and says where each comes from', () => {
    const entries = nodePickEntries(found, 'c:\\FNM\\v24\\node.exe', { path: 'C:\\node.exe', version: '20.19.4' });
    expect(entries.map((e) => e.label)).toEqual([
      'found on this computer',
      '$(check) Node.js 24.22.3',
      '$(blank) Node.js 22.23.5',
      'other',
      '$(folder-opened) Browse for node…',
      '$(sparkle) Pick automatically',
    ]);
    expect(entries[1]).toMatchObject({ description: 'fnm · in use', detail: 'C:\\fnm\\v24\\node.exe', inUse: true });
    expect(entries[2]).toMatchObject({ description: 'fnm', inUse: false });
    expect(entries.at(-1)).toMatchObject({
      detail: 'PATH first (now Node.js 20.19.4, too old), then the newest found',
    });
  });

  it('describes the automatic choice when the PATH has no node', () => {
    expect(nodePickEntries([], undefined, undefined).map((e) => e.kind)).toEqual(['separator', 'browse', 'auto']);
    expect(nodePickEntries([], undefined, undefined).at(-1)).toMatchObject({
      detail: 'PATH first (none there now), then the newest found',
    });
  });
});
