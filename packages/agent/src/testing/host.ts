// A stand-in for the CLI or VS Code: starts the agent through the launcher and then just stays alive,
// so a test can kill this whole process tree and check that the agent survives.
// Run bundled: `node host.mjs --data-dir <dir> --entry <agent.js>`.
import { homedir } from 'node:os';
import { NodeFileSystem, NodeProcessTable, createLayout } from '@everport/core';
import { startAgent } from '../launcher.js';

const arg = (flag: string): string => process.argv[process.argv.indexOf(flag) + 1] ?? '';

const layout = createLayout({ platform: process.platform, env: process.env, home: homedir() }, arg('--data-dir'));
const client = await startAgent({
  fs: new NodeFileSystem(),
  processTable: new NodeProcessTable(),
  layout,
  nodePath: process.execPath,
  entryPath: arg('--entry'),
  startTimeoutMs: 20_000,
});
console.log(`ready ${(await client.status()).pid}`);
setInterval(() => {}, 1000); // stay alive until the test kills this process tree
