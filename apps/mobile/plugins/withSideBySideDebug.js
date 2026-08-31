/**
 * Let the debug build sit on the phone next to the release one.
 *
 * Android identifies an installed app by its application id, so two builds that
 * share one can never both be on a device — installing the second replaces the
 * first, and the release build a change is being checked against disappears the
 * moment the debug build lands. That is exactly backwards for testing: the
 * comparison is the point.
 *
 * So the debug variant takes `.debug` on the end of its application id, its own
 * launcher label, and `-debug` on its version name (visible in Settings → Apps,
 * which is otherwise the only way to tell two identically-named apps apart).
 *
 * **Push does not work in the debug build**, and cannot until somebody registers
 * the suffixed id as a second Android app in the Firebase project. The Google
 * Services gradle plugin fails a build outright when `google-services.json` has
 * no client for the application id being built — so rather than fail, the debug
 * variant skips that task and runs without Firebase config. That is the same
 * no-push mode `app.config.ts` already supports for anybody building this repo
 * without a Firebase account, and it degrades the way `lib/push.ts` describes:
 * registering for push says it cannot, and nothing throws. Release builds are
 * untouched and keep their Firebase config.
 *
 * To give the debug build push as well: add an Android app for
 * `<package>.debug` in the Firebase console, download the regenerated
 * `google-services.json` (it carries both clients), and delete the
 * `whenTaskAdded` block below.
 */

const { withAppBuildGradle, withDangerousMod } = require('expo/config-plugins');
const { mkdirSync, writeFileSync } = require('node:fs');
const { join } = require('node:path');

const MARKER = 'waves:side-by-side-debug';

/** What the launcher calls the debug build, so the two icons are tellable apart. */
const DEBUG_LABEL = 'Waves dev';

const DEBUG_BUILD_TYPE = `        debug {
            signingConfig signingConfigs.debug`;

const DEBUG_BUILD_TYPE_PATCHED = `        debug {
            // ${MARKER} — see apps/mobile/plugins/withSideBySideDebug.js
            applicationIdSuffix '.debug'
            versionNameSuffix '-debug'
            signingConfig signingConfigs.debug`;

const SKIP_GOOGLE_SERVICES = `
// ${MARKER} — the debug variant's application id has no Firebase client, and
// the Google Services plugin fails the build rather than skipping. Push is the
// only thing that needs it; see apps/mobile/plugins/withSideBySideDebug.js.
tasks.whenTaskAdded { task ->
    if (task.name == 'processDebugGoogleServices') task.enabled = false
}
`;

const GOOGLE_SERVICES_APPLY = "apply plugin: 'com.google.gms.google-services'";

module.exports = function withSideBySideDebug(config) {
  const withGradle = withAppBuildGradle(config, (gradleConfig) => {
    let contents = gradleConfig.modResults.contents;
    if (contents.includes(MARKER)) return gradleConfig;

    if (!contents.includes(DEBUG_BUILD_TYPE)) {
      throw new Error('withSideBySideDebug: could not find the debug buildType in build.gradle');
    }
    contents = contents.replace(DEBUG_BUILD_TYPE, DEBUG_BUILD_TYPE_PATCHED);

    // Only where the Google Services plugin is actually applied: a build with no
    // `google-services.json` never adds the plugin, and has no task to disable.
    if (contents.includes(GOOGLE_SERVICES_APPLY)) {
      contents = contents.replace(
        GOOGLE_SERVICES_APPLY,
        `${GOOGLE_SERVICES_APPLY}\n${SKIP_GOOGLE_SERVICES}`,
      );
    }

    gradleConfig.modResults.contents = contents;
    return gradleConfig;
  });

  // The label lives in the debug source set rather than in `strings.xml`, where
  // it would rename the release build too. A resource defined in a build type's
  // source set replaces the one in `main` for that variant only.
  return withDangerousMod(withGradle, [
    'android',
    (modConfig) => {
      const values = join(
        modConfig.modRequest.platformProjectRoot,
        'app',
        'src',
        'debug',
        'res',
        'values',
      );
      mkdirSync(values, { recursive: true });
      writeFileSync(
        join(values, 'strings.xml'),
        `<resources>\n  <string name="app_name">${DEBUG_LABEL}</string>\n</resources>\n`,
        'utf8',
      );
      return modConfig;
    },
  ]);
};
