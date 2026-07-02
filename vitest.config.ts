import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    pool: 'forks',
    setupFiles: ['./src/__tests__/setup.ts'],
    fileParallelism: true,
    maxWorkers: 4,
    testTimeout: 90_000,
    hookTimeout: 30_000,
    include: ['src/__tests__/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'json-summary', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/__tests__/**', 'src/types/vendor/**'],
    },
  },
});
