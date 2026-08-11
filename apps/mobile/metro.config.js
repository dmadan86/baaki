// Metro configuration.
//
// This exists for one reason: Sentry source maps. `getSentryExpoConfig` is
// Expo's own `getDefaultConfig` with two things added — a debug ID stamped into
// every bundle and its source map so a minified production stack trace can be
// symbolicated, and a serializer that uploads those maps at build time. Without
// it, crashes from a release build arrive as unreadable one-letter frames.
//
// It is a drop-in for `expo/metro-config`: same monorepo detection, same
// defaults. The only options set are ours —
//
//   includeWebReplay: false
//     Session replay is not part of this app's Sentry setup (see
//     `src/lib/observability.ts` — crash and session tracking only, and a
//     screen here is a full view of someone's ledger). There is a web target
//     (`app.json` output: static), so without this the web bundle would pull
//     the replay packages for a feature that is deliberately off.
//
// Reporting itself is still gated on `EXPO_PUBLIC_SENTRY_DSN`, and source-map
// upload on `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` at build time
// (see `app.config.ts`). A clone with none of those set bundles exactly as
// before — this config changes how the bundle is built, not whether anything
// is sent.

const { getSentryExpoConfig } = require('@sentry/react-native/metro');

const config = getSentryExpoConfig(__dirname, { includeWebReplay: false });

module.exports = config;
