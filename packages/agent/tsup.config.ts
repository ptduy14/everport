import { defineConfig } from 'tsup';

// One self-contained file: the detached agent must run with plain `node dist/agent.js`, with no node_modules.
export default defineConfig({
  entry: { agent: 'src/main.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/.*/],
});
