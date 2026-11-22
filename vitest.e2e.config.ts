import { defineConfig } from 'vitest/config';

// End-to-end tests: real workerd through `wrangler dev`, and (when asked) real Cloudflare. One file at a time.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.e2e.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
