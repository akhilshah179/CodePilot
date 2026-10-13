import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      { test: { name: 'analyzer', root: 'packages/analyzer', include: ['test/**/*.test.ts'], exclude: ['test/fixtures/**'], testTimeout: 60_000 } },
      { test: { name: 'server', root: 'server', include: ['test/**/*.test.ts'], exclude: ['test/fixtures/**'], testTimeout: 60_000 } },
      { test: { name: 'web', root: 'web', include: ['src/**/*.test.{ts,tsx}'], environment: 'jsdom' } },
    ],
  },
});
