/**
 * Keep CMake's object paths under its own limit, on Windows.
 *
 * Five of this app's dependencies compile C++ — reanimated, worklets, screens,
 * gesture-handler, expo-modules-core. CMake refuses an object file whose full
 * path exceeds 250 characters (`CMAKE_OBJECT_PATH_MAX`), and pnpm's store
 * spends 192 of them before the object is even named:
 *
 *   node_modules/.pnpm/react-native-screens@4.26.2_2e35a…/node_modules/
 *     react-native-screens/android/.cxx/Debug/4p3m6i70/arm64-v8a/
 *     CMakeFiles/rnscreens.dir/
 *
 * What that produces is not a clear error about path length. CMake logs a
 * warning nobody reads, then ninja regenerates its manifest in a loop and dies
 * with `manifest 'build.ninja' still dirty after 100 tries`, ten minutes into
 * the build, naming a dependency the author never touched. Enabling Windows
 * long paths does not help: the 250 is CMake's, not the filesystem's.
 *
 * So the native staging directory moves to the root of a drive, which gives the
 * object names the room they need.
 *
 * **This has to go in `settings.gradle`.** AGP reads `buildStagingDirectory`
 * while each subproject configures itself, so the root build script is already
 * too late — it fails with "it is too late to set buildStagingDirectory, it has
 * already been read". `gradle.beforeProject` is the hook that is guaranteed to
 * run first.
 *
 * macOS and Linux are untouched. They have no such problem, and a build output
 * outside the project is a surprise worth avoiding where it buys nothing.
 */

// The `expo/config-plugins` sub-export, not the `@expo/config-plugins` package
// directly: same module, but the version is then pinned to the installed expo
// rather than a second copy this repo would have to keep in step (expo-doctor
// flags the direct dependency for exactly this reason).
const { withSettingsGradle } = require('expo/config-plugins');

const MARKER = 'baaki:short-native-build-path';

/** Where the native build goes. Short by definition — that is the entire point. */
const STAGING_ROOT = 'C:/cxx';

const SNIPPET = `
// ${MARKER} — see apps/mobile/plugins/withShortNativeBuildPath.js
if (System.getProperty("os.name").toLowerCase().contains("windows")) {
  gradle.beforeProject { project ->
    ["com.android.library", "com.android.application"].each { pluginId ->
      project.plugins.withId(pluginId) {
        project.android.externalNativeBuild.cmake.buildStagingDirectory =
          new File("${STAGING_ROOT}/" + project.name)
      }
    }
  }
}
`;

module.exports = function withShortNativeBuildPath(config) {
  return withSettingsGradle(config, (gradleConfig) => {
    if (gradleConfig.modResults.contents.includes(MARKER)) return gradleConfig;
    gradleConfig.modResults.contents += SNIPPET;
    return gradleConfig;
  });
};
