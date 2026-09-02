/**
 * Give the Gradle daemon enough Metaspace to build this app in one clean pass.
 *
 * Expo's generated `gradle.properties` ships `-Xmx2048m -XX:MaxMetaspaceSize=512m`.
 * That 512 MiB metaspace is enough for a warm, incremental build, but a full
 * clean `assembleRelease` — every dependency's Kotlin/Java compiled at once,
 * with `react-native-maps` now in the set — exhausts it, and the daemon dies
 * mid-task with `java.lang.OutOfMemoryError: Metaspace`. The failure surfaces on
 * whichever task was running (we saw it on `processReleaseGoogleServices`), not
 * on the real cause, so it reads like an unrelated plugin error.
 *
 * `prebuild` regenerates `gradle.properties`, so raising it once by hand would
 * not survive the next prebuild — anyone building would hit the same wall. This
 * plugin re-applies the bump every prebuild: a roomier metaspace and heap, and
 * the class-metadata GC that keeps long daemon sessions from creeping back up.
 */

const { withGradleProperties } = require('expo/config-plugins');

// Heap and metaspace the clean build needs; `-XX:+UseCompressedClassPointers`
// and class-unloading keep metaspace from growing unbounded across builds.
const JVM_ARGS =
  '-Xmx4096m -XX:MaxMetaspaceSize=1024m -XX:+HeapDumpOnOutOfMemoryError -XX:+UseParallelGC';

module.exports = function withGradleMemory(config) {
  return withGradleProperties(config, (cfg) => {
    const props = cfg.modResults;
    // Drop any existing org.gradle.jvmargs so ours is the only one that stands.
    const filtered = props.filter(
      (item) => !(item.type === 'property' && item.key === 'org.gradle.jvmargs'),
    );
    filtered.push({ type: 'property', key: 'org.gradle.jvmargs', value: JVM_ARGS });
    cfg.modResults = filtered;
    return cfg;
  });
};
