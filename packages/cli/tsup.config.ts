import { readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Options } from 'tsup';

const { version } = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')) as { version: string };

// The three configs write into the same dist/, so it is emptied here once, not by each of them.
rmSync(fileURLToPath(new URL('./dist', import.meta.url)), { recursive: true, force: true });

const forNode: Options = { format: ['esm'], platform: 'node', target: 'node22', noExternal: [/.*/], clean: false };

// One package ships three self-contained files: the CLI, the background agent (started with `node agent.js`) and
// the relay Worker (deployed to Cloudflare). The CLI finds the other two next to itself.
export default defineConfig([
  {
    ...forNode,
    entry: { everport: 'src/everport.ts' },
    banner: { js: '#!/usr/bin/env node' },
    define: { __EVERPORT_VERSION__: JSON.stringify(version) },
  },
  { ...forNode, entry: { agent: '../agent/src/main.ts' } },
  {
    entry: { worker: '../relay/src/worker/index.ts' },
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    clean: false,
    noExternal: [/^(?!cloudflare:)/],
    external: [/^cloudflare:/],
  },
]);
