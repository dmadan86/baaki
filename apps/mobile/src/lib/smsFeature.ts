/**
 * The two gates the inbox reader has to pass, and the one rule that decides
 * whether pasting is offered at all.
 *
 * `sms_inbox_read` has sat in `feature_flags` since the baseline migration with
 * `enabled=false`, read by nothing. This file is what makes it real. It is not
 * a second flag mechanism: the variant still comes from `lib/flags.tsx`, which
 * is the one place this app asks the server what is switched on.
 *
 * TWO GATES, AND NEITHER SUBSTITUTES FOR THE OTHER.
 *
 *   1. **Build.** `plugins/withSmsReader.js` puts `android.permission.READ_SMS`
 *      in the manifest only when `WAVES_SMS_READER=1` was set at prebuild.
 *      Google Play scans the manifest of the artefact it is given, and a
 *      restricted permission held without an approved core use case is grounds
 *      for removal — so a runtime switch is no help at all here, and the
 *      default artefact simply must not contain the permission.
 *      `app.config.ts` records the same decision in `extra.smsReader` so the
 *      running app can read it back rather than guess.
 *
 *   2. **Runtime.** `sms_inbox_read` decides whether a phone that *could* read
 *      the inbox is offered the option. Off is the fallback for everything:
 *      no session, no flag row, a failed fetch (`lib/flags.tsx` says why).
 *
 *   3. **Account.** A guest may not read bank messages at all. The messages
 *      never leave the phone either way, but the expenses they become are kept
 *      under an identity a guest cannot sign back into, and an hour of reading
 *      somebody's bank texts into a ledger they will lose with the handset is
 *      not a trade the app should offer. `components/SignInWall` is the wall;
 *      this is the switch behind every door to it.
 *
 * The variant is compared against `'treatment'` rather than merely asked
 * whether the person is enrolled. The flag's arms are `{control, treatment}`,
 * and "enrolled at all" would hand the reader to the control group too —
 * which is both a broken experiment and a wider exposure of a restricted
 * permission than anybody asked for. `useFlagVariant` returning null (outside
 * the rollout) means "behave as the app did before the flag existed", which is
 * exactly: paste only.
 *
 * Pasting itself is gated by neither. It needs no permission, works on iPhone,
 * and is the whole feature on iOS.
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { useAuth } from '@/lib/auth';
import { useFlagVariant, useFlagVerdict } from '@/lib/flags';

/** The flag row seeded in the baseline migration. */
export const SMS_INBOX_READ_FLAG = 'sms_inbox_read';

/** The arm that gets the reader. The other arm is the app as it ships today. */
const TREATMENT = 'treatment';

/**
 * Does the binary this is running in declare `READ_SMS`?
 *
 * Read from the config rather than probed: the native module autolinks into
 * every Android build whether or not the manifest declares the permission, so
 * "the module is there" answers a different question. Wrapped because
 * `expoConfig` is null in a few hosts (a bare runtime, some test harnesses) and
 * a missing key must read as "no", never as a crash on a screen that only
 * wanted to decide whether to draw a button.
 */
export function smsReaderInBuild(): boolean {
  try {
    return (Constants.expoConfig?.extra as { smsReader?: unknown } | undefined)?.smsReader === true;
  } catch {
    return false;
  }
}

/**
 * Whether this phone may be offered "read my messages" at all.
 *
 * Android, a build that declares the permission, and the treatment arm — all
 * three, every time. Called by the paste screen (to decide whether to show the
 * entry point) and by the disclosure screen itself (so a deep link or a stale
 * back-stack cannot reach the permission prompt after the flag is turned off).
 */
export function useSmsInboxReader(): boolean {
  const variant = useFlagVariant(SMS_INBOX_READ_FLAG);
  const { isGuest } = useAuth();
  return Platform.OS === 'android' && smsReaderInBuild() && variant === TREATMENT && !isGuest;
}

/**
 * The same two gates, for a caller that has to act on "no" as well as "yes".
 *
 * A screen only ever needs the boolean: it draws the button or it does not, and
 * "we have not read the flag table yet" may as well be "no" for the second it
 * lasts. The automatic reader cannot be so relaxed, because its "no" cancels a
 * scheduled background job — and cancelling one because a phone was offline at
 * launch, then rescheduling it when the fetch finally lands, is churn rather
 * than caution. So this keeps the three answers apart:
 *
 *   - `'on'`    — Android, a build that declares the permission, treatment arm.
 *   - `'off'`   — the flag table was read and this phone is not to read messages.
 *                 Also every iPhone and every build without the permission, both
 *                 of which are settled facts needing no network to establish.
 *   - `'unknown'` — the flag table has not come back. Change nothing.
 */
export type SmsInboxReaderVerdict = 'on' | 'off' | 'unknown';

export function useSmsInboxReaderVerdict(): SmsInboxReaderVerdict {
  const { variant, settled } = useFlagVerdict(SMS_INBOX_READ_FLAG);
  const { isGuest } = useAuth();
  // Neither of these can change without a new binary, so they are answers now
  // rather than answers pending, and they are checked first so a phone that can
  // never read is never left waiting on a fetch to say so.
  if (Platform.OS !== 'android' || !smsReaderInBuild()) return 'off';
  // A guest is a settled "no" as well, and it belongs here rather than only on
  // the screens: this verdict schedules the background reader, and a guest
  // whose messages were being read hourly while every door to the results was
  // shut would be the worst of both.
  if (isGuest) return 'off';
  if (!settled) return 'unknown';
  return variant === TREATMENT ? 'on' : 'off';
}
