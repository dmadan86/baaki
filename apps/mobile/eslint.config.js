const path = require('path');

const expoConfig = require('eslint-config-expo/flat');

/**
 * Said once, because the two selectors that catch a native alert are two
 * spellings of the same mistake.
 */
/**
 * Comparing `profile_id` by hand is the bug that showed a ghost's balance as
 * yours.
 *
 * A ghost is a member with no `profile_id`. An unloaded profile is `undefined`,
 * threaded down as `null`. So `member.profile_id === profile?.id` matches the
 * *first ghost in the group* for the first second of every cold start — and the
 * screens that ask it were deciding whose balance to show, who to record as
 * having paid, and whether to call somebody "You". The dashboard rendered a
 * −₹82,001 that was really a +₹112,807, with the sign, the colour, the label and
 * every group row agreeing.
 *
 * `isViewer(member, viewerId)` matches nothing when there is no viewer, and
 * `isGhost(member)` is the one place allowed to ask the other question. Both
 * live in `data/types.ts`, which is exempt below because it is where they are
 * defined.
 */
const VIEWER_MESSAGE =
  'Do not compare profile_id directly — use isViewer(member, viewerId) from @/data/types ' +
  '(or isGhost(member)). A bare comparison matches the first ghost while the profile is ' +
  'still loading. Identity comes from useViewerId(), not profile?.id.';

const ALERT_MESSAGE =
  'Use `useDialog()` (@/lib/dialog) for a question and `useToast()` (@/lib/toast) for a notice. `Alert.alert` is the native dialog this app replaced.';

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
            {
              // The stock alert is a different application's window borrowed for
              // a moment — grey slab, square corners, two identical capitals —
              // over a screen of rounded cards and brand purple, and it can be
              // told nothing but strings. Every one of the forty-nine call sites
              // it had is now `useDialog()` or `useToast()`; this is what stops
              // the fiftieth. Everything else in react-native is fine.
              name: 'react-native',
              importNames: ['Alert'],
              message:
                'Use `useDialog()` (@/lib/dialog) for a question and `useToast()` (@/lib/toast) for a notice. `Alert` is the native dialog this app replaced.',
            },
            {
              // One tap, one screen. `@/lib/navigation` is expo-router's router
              // with a short guard in front of it, so a double tap cannot push
              // the same route twice — a bug you only see on a real phone, and
              // one that comes straight back the moment a screen imports the
              // raw router again.
              name: 'expo-router',
              importNames: ['router', 'useRouter'],
              message:
                'Import `router` / `useRouter` from `@/lib/navigation` — the guarded router. Everything else in expo-router is fine to import directly.',
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
      // The import rule cannot see `require('react-native').Alert`, and this
      // repo reaches for a lazy `require` on purpose (see lib/restart.ts, where
      // a hoisted import of a missing native module kills the app at launch).
      // This catches the call however `Alert` was got hold of.
      'no-restricted-syntax': [
        'error',
        {
          // `Alert.alert(…)`, however `Alert` was bound — including out of a
          // destructured `require`.
          selector: "MemberExpression[object.name='Alert'][property.name='alert']",
          message: ALERT_MESSAGE,
        },
        {
          // `RN.Alert.alert(…)` and `require('react-native').Alert.alert(…)`.
          selector: "MemberExpression[property.name='alert'][object.property.name='Alert']",
          message: ALERT_MESSAGE,
        },
        {
          // `member.profile_id === someId`, either way round.
          selector:
            "BinaryExpression[operator=/^[!=]==$/] > MemberExpression[property.name='profile_id']",
          message: VIEWER_MESSAGE,
        },
      ],
    },
  },
  {
    // Where `isViewer` and `isGhost` are defined, and therefore the one file
    // that has to compare `profile_id` directly.
    files: ['**/data/types.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    // The adapter and the port are the two places the vendor is allowed.
    files: ['**/lib/supabase.ts', '**/lib/backend/index.ts'],
    rules: { 'no-restricted-imports': 'off' },
  },
];
