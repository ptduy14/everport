// Entry point of the detached agent process: `node agent.js --data-dir <dir>`. Bundled by tsup into dist/agent.js.
import { appendFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { FileLogger, NodeFileSystem, NodeProcessTable, createLayout, localStamp } from '@everport/core';
import { runDaemon, type Daemon } from './daemon.js';

const argIndex = process.argv.indexOf('--data-dir');
const dataDir = argIndex >= 0 ? process.argv[argIndex + 1] : undefined;

const layout = createLayout({ platform: process.platform, env: process.env, home: homedir() }, dataDir);
const fs = new NodeFileSystem();
const logger = new FileLogger(fs, layout.agentLogFile);

let daemon: Daemon | undefined;
let exiting = false;
const exit = (code: number) => {
  exiting = true;
  void logger.flush().then(() => process.exit(code));
};

const fail = (what: string, e: unknown) => {
  logger.error(`${what}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  if (daemon) void daemon.shutdown(1);
  else exit(1);
};

process.on('uncaughtException', (e) => fail('uncaught exception', e));
process.on('unhandledRejection', (e) => fail('unhandled rejection', e));
// SIGHUP: the console window closed; SIGBREAK: Ctrl+Break on Windows.
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP', 'SIGBREAK'] as const) {
  process.on(signal, () => {
    logger.info(`agent received ${signal}`);
    void daemon?.shutdown(0);
  });
}
// Any other way out (a kill that runs no handler leaves no trace at all). Synchronous: nothing async runs here.
process.on('exit', (code) => {
  if (exiting) return;
  try {
    appendFileSync(layout.agentLogFile, `${localStamp(new Date())} WARN agent exited unexpectedly (code ${code})\n`);
  } catch {
    // the log is best effort
  }
});

runDaemon({ layout, fs, logger, pid: process.pid, processTable: new NodeProcessTable(), onExit: exit })
  .then((d) => {
    daemon = d;
  })
  .catch((e) => {
    // the message goes to stdout too, which the launcher redirects to agent.out.log and quotes when the start fails
    console.error(e instanceof Error ? e.message : String(e));
    fail('could not start', e);
  });
