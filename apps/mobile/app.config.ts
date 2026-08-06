/**
 * `app.json` stays the app's description of itself. This file adds the one
 * thing that cannot be written down statically.
 *
 * Sentry's config plugin uploads source maps during the native build, which is
 * the difference between a stack trace and a column number in a minified
 * bundle. To do that it needs an organisation and a project — values that
 * belong to whoever is building, not to the repository. Hard-coding a
 * placeholder would make `expo prebuild` fail for anybody who cloned this and
 * has no Sentry account, so the plugin is added only when the build is
 * actually configured to talk to Sentry.
 *
 * Reporting itself is a separate switch (`EXPO_PUBLIC_SENTRY_DSN`): a build can
 * report crashes without uploading source maps, and reads them minified.
 */

import type { ExpoConfig } from 'expo/config';

import appJson from './app.json';

export default (): ExpoConfig => {
  const config = appJson.expo as ExpoConfig;

  const organization = process.env.SENTRY_ORG;
  const project = process.env.SENTRY_PROJECT;
  if (!organization || !project) return config;

  return {
    ...config,
    plugins: [
      ...(config.plugins ?? []),
      [
        '@sentry/react-native/expo',
        { organization, project, url: process.env.SENTRY_URL ?? 'https://sentry.io/' },
      ],
    ],
  };
};
