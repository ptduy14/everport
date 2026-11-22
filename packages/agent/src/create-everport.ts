// The composition root: builds an Everport wired to the real file system, wrangler, Cloudflare and background agent.
import { homedir } from 'node:os';
import {
  EventBus,
  Everport,
  FileLogger,
  NodeFileSystem,
  NodeProcessTable,
  NodeRelayProbe,
  NodeWranglerRunner,
  RelayDeployer,
  createLayout,
} from '@everport/core';
import { ProcessAgentControl } from './agent-control.js';

export interface CreateEverportOptions {
  /** Where Everport keeps its files. Default: the per-user data folder of the OS. */
  dataDir?: string;
  /** The built relay Worker (`dist/worker.js` of @everport/relay). */
  workerFile: string;
  /** The built background agent (`dist/agent.js` of @everport/agent). */
  agentEntry: string;
  /** Name of the relay Worker in the user's Cloudflare account. Default `everport`. */
  workerName?: string;
  /** The node binary that runs the agent. Default: the one running this code. */
  nodePath?: string;
}

export function createEverport(options: CreateEverportOptions): Everport {
  const layout = createLayout({ platform: process.platform, env: process.env, home: homedir() }, options.dataDir);
  const fs = new NodeFileSystem();
  const processTable = new NodeProcessTable();
  const logger = new FileLogger(fs, layout.logFile);
  const wrangler = new NodeWranglerRunner();
  const deployer = new RelayDeployer({
    wrangler,
    probe: new NodeRelayProbe(),
    fs,
    layout,
    logger,
    workerFile: options.workerFile,
  });
  const agent = new ProcessAgentControl({
    fs,
    processTable,
    layout,
    nodePath: options.nodePath ?? process.execPath,
    entryPath: options.agentEntry,
  });
  return new Everport({
    layout,
    fs,
    logger,
    events: new EventBus(),
    deployer,
    agent,
    wrangler,
    processTable,
    pid: process.pid,
    ...(options.workerName && { workerName: options.workerName }),
  });
}
