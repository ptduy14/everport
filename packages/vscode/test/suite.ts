// Runs inside a real VS Code (extension host). Started by test/run.mjs through @vscode/test-electron.
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { createEverport } from '@everport/agent';
import { NodePortScanner, NodeProcessTable, NodeWranglerRunner, scanPorts } from '@everport/core';
import { findNode } from '../src/node-path.js';

const out = process.env['EVERPORT_TEST_OUT'] ?? '';

async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    console.log(`ok   ${name}`);
  } catch (e) {
    console.log(`FAIL ${name}`);
    throw e;
  }
}

export async function run(): Promise<void> {
  assert.ok(out, 'EVERPORT_TEST_OUT is required');
  const ext = vscode.extensions.getExtension('everport-dev.everport-vscode');
  assert.ok(ext, 'extension not found');

  await check('extension activates and registers its commands', async () => {
    await ext.activate();
    assert.ok(ext.isActive);
    const commands = await vscode.commands.getCommands(true);
    for (const id of ['add', 'upAll', 'downAll', 'refresh', 'start', 'stop', 'remove', 'login', 'doctor'])
      assert.ok(commands.includes(`everport.${id}`), `missing everport.${id}`);
  });

  await check('the agent and the Worker ship next to the extension', async () => {
    for (const file of ['extension.js', 'agent.mjs', 'worker.js'])
      assert.ok(existsSync(join(ext.extensionPath, 'dist', file)), `dist/${file} is missing`);
  });

  await check('refresh works with an empty data dir', async () => {
    await vscode.commands.executeCommand('everport.refresh');
  });

  // The agent is started this way: a child of VS Code's own binary (process.execPath -e on macOS/Linux).
  // run.mjs checks after VS Code has exited that the child is still alive.
  await check('a detached child is started from the extension host', async () => {
    const win = process.platform === 'win32';
    const pid = await new NodeProcessTable().spawnDetached(
      win ? 'ping' : 'sleep',
      win ? ['-n', '300', '127.0.0.1'] : ['300'],
      join(out, '..', 'detached.log'),
    );
    assert.ok(pid, 'no pid returned');
    await writeFile(out, JSON.stringify({ pid, execPath: process.execPath }));
  });

  await check('port scan sees a server in the extension host', async () => {
    const server = http.createServer((_q, s) => s.end('ok'));
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const port = (server.address() as AddressInfo).port;
    try {
      const all = await scanPorts(new NodePortScanner(), { workspaceFolders: [] });
      const mine = all.find((c) => c.port === port);
      assert.ok(mine, `port ${port} not found among ${all.map((c) => c.port).join(',')}`);
      assert.equal(mine.http, 200);
      console.log(`     port ${port}: group=${mine.group} label=${mine.label}`);
    } finally {
      server.close();
    }
  });

  // Opt-in (EVERPORT_E2E_CLOUDFLARE=1): the whole flow on the real Cloudflare account, driven from inside the
  // extension host, where process.execPath is Electron. Needs `wrangler login` done. Creates and removes ep-smoke-*.
  if (process.env['EVERPORT_E2E_CLOUDFLARE'] === '1') {
    await check('real Cloudflare: add, serve, down, up and remove from the extension host', async () => {
      const probe = (cmd: string, args: string[]) =>
        new Promise<string | undefined>((r) =>
          execFile(cmd, args, { windowsHide: true }, (e, o) => r(e ? undefined : o)),
        );
      const nodePath = await findNode('', probe);
      const dist = join(ext.extensionPath, 'dist');
      const workerName = `ep-smoke-${Math.random().toString(16).slice(2, 8)}`;
      const ep = createEverport({
        workerFile: join(dist, 'worker.js'),
        agentEntry: join(dist, 'agent.mjs'),
        nodePath,
        workerName,
      });
      const origin = http.createServer((_q, s) => s.end('hello from the extension host'));
      await new Promise<void>((r) => origin.listen(0, '127.0.0.1', r));
      const port = (origin.address() as AddressInfo).port;
      const body = async (url: string) => (await fetch(url, { signal: AbortSignal.timeout(20_000) })).text();
      try {
        assert.ok(await ep.isLoggedIn(), 'not logged in to Cloudflare: run "everport login" first');
        const t = await ep.add({ target: `http://127.0.0.1:${port}`, label: 'vs' });
        assert.equal(t.state, 'active', JSON.stringify(t.error));
        assert.equal(await body(t.url), 'hello from the extension host');
        console.log(`     added ${t.url}`);
        await ep.down();
        assert.equal((await fetch(t.url)).status, 503);
        const up = await ep.up();
        assert.equal(up[0]?.state, 'active', JSON.stringify(up[0]?.error));
        assert.equal(await body(t.url), 'hello from the extension host');
        await ep.remove('vs');
      } finally {
        origin.close();
        await ep.down().catch(() => undefined);
        await new NodeWranglerRunner(undefined, nodePath).run(['delete', '--name', workerName, '--force'], {
          timeoutMs: 120_000,
        });
      }
    });
  }
}
