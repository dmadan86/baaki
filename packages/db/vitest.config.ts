import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
    // The twenty-user scenario is a slow end-to-end run with its own CI job and
    // its own config (vitest.scenario.config.ts); keep it out of the fast
    // invariant suite so the two do not run it twice.
    exclude: [...configDefaults.exclude, 'test/scenario-twenty-users.test.ts'],
    // The suites share one Postgres and assert on global state; run them serially.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.d.ts', 'generated/**'],
    },
  },
});
