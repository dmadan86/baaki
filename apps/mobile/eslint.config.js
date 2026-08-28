const path = require('path');

const expoConfig = require('eslint-config-expo/flat');

/**
 * Expo's shared config already turns on `import/no-unresolved` and wires an
 * `import/resolver.typescript` entry — but that only resolves the `@/*` path
 * alias if `eslint-import-resolver-typescript` is actually installed. It has
 * been reaching us transitively through `eslint-config-expo`, which is fragile:
 * a hoist change or a fresh install in a different layout (e.g. a reviewer's CI)
 * drops the resolver and every `@/lib/...` import lights up as unresolved.
 *
 * So we depend on the resolver directly (see package.json) and point it at this
 * app's tsconfig here, making `@/*` resolution explicit and layout-independent
 * rather than a side effect of Expo's dependency tree.
 */
module.exports = [
  ...expoConfig,
  {
    settings: {
      // eslint-plugin-react (via eslint-config-expo) auto-detects the installed
      // React version by calling context.getFilename(), which ESLint 10 removed —
      // that path throws before any rule runs. Pinning the version skips detection.
      // Keep in sync with the `react` dependency in package.json.
      react: { version: '19.2' },
      'import/resolver': {
        typescript: {
          project: path.join(__dirname, 'tsconfig.json'),
        },
      },
    },
  },
  {
    ignores: ['dist/*', '.expo/*', 'expo-env.d.ts'],
  },
  // Keep the backend seam intact: everything talks to the `Backend` port
  // (`@/lib/backend`); only the adapter is allowed to name the vendor. A stray
  // `import { supabase }` re-couples the app and must fail here, not in review.
  {
    files: ['**/*.{ts,tsx}'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [
            {
              name: '@supabase/supabase-js',
              message:
                'Import through the backend port (`@/lib/backend`). Only lib/supabase.ts (the adapter) may name the vendor.',
            },
            {
              name: '@/lib/supabase',
              message: 'Import `backend` from `@/lib/backend`, not the Supabase client directly.',
            },
          ],
          patterns: [
            {
              group: ['**/lib/supabase'],
              message: 'Import through the backend port (`@/lib/backend`).',
            },
          ],
        },
      ],
    },
  },
  {
    // The adapter and the port are the two places the vendor is allowed.
    files: ['**/lib/supabase.ts', '**/lib/backend/index.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
