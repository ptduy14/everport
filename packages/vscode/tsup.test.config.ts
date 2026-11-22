import { defineConfig } from 'tsup';

// The in-VS Code test suite, bundled like the extension.
export default defineConfig({
  entry: { suite: 'test/suite.ts' },
  outDir: 'dist-test',
  format: ['cjs'],
  platform: 'node',
  target: 'node22',
  external: ['vscode'],
  noExternal: [/^(?!vscode$).*/],
  clean: true,
});
