import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/dist-test/**',
      '**/.vscode-test/**',
      '**/node_modules/**',
      '**/.wrangler/**',
      'planning/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
