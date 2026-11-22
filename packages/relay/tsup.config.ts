import { defineConfig } from 'tsup';

// The Worker as one file. `cloudflare:workers` is provided by the Cloudflare runtime, so it stays an import.
export default defineConfig({
  entry: { worker: 'src/worker/index.ts' },
  format: ['esm'],
  platform: 'neutral',
  target: 'es2022',
  outDir: 'dist',
  clean: true,
  splitting: false,
  noExternal: [/^(?!cloudflare:)/],
  external: [/^cloudflare:/],
});
