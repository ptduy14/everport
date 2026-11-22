import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    // Slow tests that need the network or a Cloudflare account run with `npm run test:e2e`.
    exclude: [...configDefaults.exclude, '**/*.e2e.test.ts'],
  },
});
