import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'tsup';

// The three configs write into the same dist/, so it is emptied here once, not by each of them.
rmSync(fileURLToPath(new URL('./dist', import.meta.url)), { recursive: true, force: true });

// The extension (CommonJS: VS Code loads it with require), the background agent (run by a real `node`, so ESM
// with .mjs) and the relay Worker (deployed to Cloudflare). The extension finds the other two next to itself.
export default defineConfig([
  {
    entry: { extension: 'src/extension.ts' },
    format: ['cjs'],
    platform: 'node',
    target: 'node22',
    external: ['vscode'],
    noExternal: [/^(?!vscode$).*/],
    clean: false,
  },
  {
    entry: { agent: '../agent/src/main.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node22',
    outExtension: () => ({ js: '.mjs' }),
    noExternal: [/.*/],
    clean: false,
  },
  {
    entry: { worker: '../relay/src/worker/index.ts' },
    format: ['esm'],
    platform: 'neutral',
    target: 'es2022',
    outExtension: () => ({ js: '.js' }),
    clean: false,
    noExternal: [/^(?!cloudflare:)/],
    external: [/^cloudflare:/],
  },
]);
