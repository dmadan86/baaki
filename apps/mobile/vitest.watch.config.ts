import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/*watch*.test.ts', 'test/*wear*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/lib/watch/**/*.ts', 'src/lib/watch/**/*.tsx', 'plugins/withWavesWear.js'],
      reportsDirectory: 'coverage-watches',
    },
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
