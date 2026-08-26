import { defineConfig } from 'vitest/config';

/**
 * The heavy end-to-end scenario runs on its own, in its own CI job, so a red
 * check names it directly and its ~70s build-up never slows the fast invariant
 * suite. It seeds twenty users, three groups and ~150 expenses in one
 * `beforeAll`, so the hook gets a long timeout the default config does not give.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/scenario-twenty-users.test.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
});
