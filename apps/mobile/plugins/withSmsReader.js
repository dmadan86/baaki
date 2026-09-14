/**
 * `READ_SMS` in the manifest — only when a build deliberately asks for it.
 *
 * WHY THIS IS A BUILD-TIME SWITCH AND NOT A RUNTIME ONE. Google Play scans the
 * uploaded artefact's merged manifest. A declared `READ_SMS` is a *restricted*
 * permission: holding it without an approved core use case from the Permissions
 * Declaration Form gets an app removed from Play, not merely an update
 * rejected, and "we never actually call it" is not a defence the scanner can
 * hear. A feature flag, however honest, is invisible to it — the permission is
 * either in the binary or it is not. So the Play artefact must not contain it,
 * full stop, and that decision has to be made where the manifest is written.
 *
 * See `docs/plan-drafts-and-rules.md` §1.2 for the policy, and
 * `docs/play-release.md` ("The one permission that can get the app removed") for
 * the same rule stated where a release is actually built.
 *
 * HOW IT IS TURNED ON. One environment variable, at prebuild time:
 *
 *     WAVES_SMS_READER=1 npx expo prebuild --platform android
 *
 * Anything else — unset, `0`, `true`, `yes` — is off. Exactly one spelling is
 * accepted on purpose: a permission this consequential should never be turned
 * on by a value somebody typed loosely.
 *
 * WHAT "OFF" MEANS, PRECISELY. Off, this plugin registers no mod at all and
 * returns the config object it was handed. It does not add an empty edit, it
 * does not normalise anything, it does not touch `android.permissions`. A
 * default build's `AndroidManifest.xml` is therefore byte-for-byte what it
 * would be with this plugin absent from `app.json` — which is the property
 * `apps/mobile/test/smsReaderPlugin.test.ts` pins, and the one a reviewer
 * should re-check by diffing two prebuilds.
 *
 * The runtime half is separate and *also* mandatory: `src/lib/smsFeature.ts`
 * gates every entry point on the `sms_inbox_read` feature flag and on this
 * build having the permission at all. Two independent gates, neither one
 * standing in for the other.
 */

const { withAndroidManifest } = require('expo/config-plugins');

const PERMISSION = 'android.permission.READ_SMS';

/** The one spelling that turns the reader on. */
function readerEnabled(env) {
  return env?.WAVES_SMS_READER === '1';
}

/**
 * Add `READ_SMS` to a parsed manifest, once.
 *
 * Takes and returns the manifest object `withAndroidManifest` hands over (the
 * xml2js shape: `{ manifest: { 'uses-permission': [{ $: { 'android:name' } }] } }`).
 * Idempotent, because prebuild can run twice over the same `android/` tree and
 * a duplicated `<uses-permission>` is a merge warning nobody reads.
 */
function manifestWithReadSms(androidManifest) {
  const manifest = androidManifest?.manifest;
  if (!manifest) throw new Error('withSmsReader: no <manifest> element to add READ_SMS to');

  const existing = Array.isArray(manifest['uses-permission']) ? manifest['uses-permission'] : [];
  if (existing.some((entry) => entry?.$?.['android:name'] === PERMISSION)) return androidManifest;

  return {
    ...androidManifest,
    manifest: {
      ...manifest,
      'uses-permission': [...existing, { $: { 'android:name': PERMISSION } }],
    },
  };
}

module.exports = function withSmsReader(config) {
  // The whole point: with the switch off, nothing is registered, so there is no
  // mod to produce a diff and no code path that could add the permission by
  // accident.
  if (!readerEnabled(process.env)) return config;

  return withAndroidManifest(config, (manifestConfig) => {
    manifestConfig.modResults = manifestWithReadSms(manifestConfig.modResults);
    return manifestConfig;
  });
};

module.exports._internals = { PERMISSION, readerEnabled, manifestWithReadSms };
