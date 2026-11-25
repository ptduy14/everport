import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NodeFileSystem, NodeProcessTable, createLayout, type Layout, type ProcessTable } from '@everport/core';
import { runDaemon, type Daemon, type DaemonOptions } from '../daemon.js';
import { FAST, SECRET, silentLogger } from './helpers.js';

type Cleanup = (() => Promise<void> | void)[];

/** A throwaway data directory laid out like the real one, with a relay secret in it unless told not to. */
export async function makeLayout(cleanup: Cleanup, withSecret = true): Promise<Layout> {
  const home = await mkdtemp(join(tmpdir(), 'everport-test-'));
  cleanup.push(() => rm(home, { recursive: true, force: true }));
  const layout = createLayout({ platform: process.platform, env: {}, home }, join(home, 'data'));
  if (withSecret) {
    await mkdir(layout.dataDir, { recursive: true });
    await writeFile(layout.relaySecretFile, `${SECRET}\n`);
  }
  return layout;
}

export interface TestDaemon {
  daemon: Daemon;
  /** Exit codes passed to onExit. */
  exits: number[];
}

/** A daemon running inside the test process (pid = the test's own pid). */
export async function startTestDaemon(
  layout: Layout,
  cleanup: Cleanup,
  over: Partial<DaemonOptions> = {},
): Promise<TestDaemon> {
  const exits: number[] = [];
  const daemon = await runDaemon({
    layout,
    fs: new NodeFileSystem(),
    logger: silentLogger,
    pid: process.pid,
    processTable: new NodeProcessTable(),
    timings: FAST,
    onExit: (code) => exits.push(code),
    ...over,
  });
  cleanup.push(() => daemon.shutdown());
  return { daemon, exits };
}

/** A ProcessTable whose notion of "alive" is set by the test. */
export class FakeProcessTable implements ProcessTable {
  alive = new Set<number>();
  killed: number[] = [];
  /** Set by a test to say when the computer last started. */
  bootTime?: () => number;
  spawned: { cmd: string; args: string[]; logFile: string }[] = [];
  onSpawn: (cmd: string, args: string[], logFile: string) => Promise<number | undefined> | number | undefined = () =>
    undefined;

  isAlive(pid: number): boolean {
    return this.alive.has(pid);
  }

  async killTree(pid: number): Promise<void> {
    this.killed.push(pid);
    this.alive.delete(pid);
  }

  async spawnDetached(cmd: string, args: string[], logFile: string): Promise<number | undefined> {
    this.spawned.push({ cmd, args, logFile });
    return this.onSpawn(cmd, args, logFile);
  }
}
