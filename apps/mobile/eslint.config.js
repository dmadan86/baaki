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
];
