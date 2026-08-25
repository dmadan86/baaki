import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Vitest project for the Supabase edge functions (Deno source, tested on Node).
 *
 * The functions target the Deno runtime, so their code uses two things Node and
 * vitest cannot resolve on their own:
 *
 *   • `npm:`/bundle imports — the Supabase SDK, aws4fetch, the Sentry SDK, and
 *     the `_shared/core.js` bundle emitted by `pnpm edge:build`. These are
 *     aliased below to lightweight stubs (for the SDKs the tests never touch a
 *     real one — handlers take clients as injected deps) and to the real
 *     `@waves/core` source (for `core.js`, so tests exercise the true code
 *     rather than depending on the git-ignored build artifact).
 *   • the `Deno` global — shimmed in `_shared/test/setup.ts`.
 *
 * Test files live beside the function they cover (`<fn>/*.test.ts`); shared
 * harness lives under `_shared/test/`, which Supabase skips at deploy time
 * because it is under an underscore-prefixed directory.
 */
const fromHere = (path: string) => fileURLToPath(new URL(path, import.meta.url));

export default defineConfig({
  // Pin the project root to this directory so the run only collects the edge
  // functions' own tests — without this vitest walks up to the repo root and
  // globs every package's suite.
  root: fromHere('.'),
  resolve: {
    alias: [
      {
        find: 'npm:@supabase/supabase-js@2',
        replacement: fromHere('./_shared/test/stubs/supabase-js.ts'),
      },
      { find: 'npm:aws4fetch@1', replacement: fromHere('./_shared/test/stubs/aws4fetch.ts') },
      { find: 'npm:@sentry/deno@10', replacement: fromHere('./_shared/test/stubs/sentry-deno.ts') },
      // The edge functions import the bundled `@waves/core` (built to
      // `_shared/core.js` by `pnpm edge:build`). Point every reference at the
      // real source so tests need no build step and exercise real behaviour.
      // Match the whole specifier (`./core.js`, `../_shared/core.js`) — a regex
      // that matched only `core.js` would rewrite just that fragment and leave a
      // broken path.
      { find: /^.*\/core\.js$/, replacement: fromHere('../../packages/core/src/index.ts') },
    ],
  },
  test: {
    globals: true,
    include: ['**/*.test.ts'],
    setupFiles: [fromHere('./_shared/test/setup.ts')],
  },
});
