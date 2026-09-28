import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      include: ['packages/domain/src/**', 'packages/backend/src/**'],
      reporter: ['text-summary', 'text'],
    },
  },
});
