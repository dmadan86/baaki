import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

/**
 * Only the pure modules under src/data are tested here — no React Native, no
 * Metro, no native modules. Anything that renders belongs in the Maestro flows
 * under e2e/ instead; standing up a React Native test renderer to assert on a
 * string would cost more than it caught.
 */
export default defineConfig({
  test: {
    globals: true,
    include: ['test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // The v3 async-storage ESM build can't be resolved by Node under vitest;
      // swap in an in-memory stub so importing it doesn't crash collection.
      '@react-native-async-storage/async-storage': fileURLToPath(
        new URL('./test/mocks/async-storage.ts', import.meta.url),
      ),
      // Ionicons pulls the native font pipeline; the pure icon-list module only
      // needs its `glyphMap` shape (in a type position), so a bare stub loads it.
      '@expo/vector-icons/Ionicons': fileURLToPath(
        new URL('./test/mocks/ionicons.ts', import.meta.url),
      ),
    },
  },
});
