import { createEverport } from '@everport/agent';
import { WRANGLER_VERSION } from '@everport/core';
import { copyToClipboard } from './clipboard.js';
import { run } from './program.js';
import { resolveRuntimeFiles } from './runtime-files.js';

const code = await run(process.argv.slice(2), {
  version: __EVERPORT_VERSION__,
  wranglerVersion: WRANGLER_VERSION,
  // The Worker name only matters for the first tunnel: after that the name stored in the configuration wins.
  createManager: async () =>
    createEverport({
      ...resolveRuntimeFiles(import.meta.url),
      ...(process.env['EVERPORT_WORKER_NAME'] ? { workerName: process.env['EVERPORT_WORKER_NAME'] } : {}),
    }),
  out: (line) => console.log(line),
  err: (line) => console.error(line),
  copy: copyToClipboard,
  debug: process.env['EVERPORT_DEBUG'] === '1',
});
process.exitCode = code;
