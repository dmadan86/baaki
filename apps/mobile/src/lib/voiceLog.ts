/**
 * Voice quick-add misses, reported to the backend so the parser can be improved
 * against what people actually said.
 *
 * The point is understanding: when someone speaks an expense and nothing usable
 * comes back ("hello, can you please add 500 for tea shop"), the team wants the
 * actual transcript to look at later — not a guess at what they might have said.
 * This used to be an on-device log with its own settings screen; it is now sent
 * silently to the server, where the admin console surfaces the unparsed ones.
 *
 * What leaves the device, and what does not:
 *
 * - **Only failures are sent.** A parse that produced at least one expense
 *   ({@link VoiceAttempt.itemCount} > 0) needs no server logging and is dropped
 *   here — the improvement signal lives entirely in the misses. This keeps the
 *   payload minimal and keeps successful, correctly-understood speech on the
 *   phone where it belongs.
 * - **Consent gates the send.** Nothing is transmitted unless the person has
 *   turned on the analytics opt-in (the session-replay switch on the privacy
 *   screen, {@link sessionReplayConsent}). With no consent — which is also the
 *   default, and the state on any build without a Clarity project — the miss is
 *   simply not reported.
 * - **The caller is identified server-side.** No profile id is sent; the RPC
 *   resolves the signed-in user from the JWT. The transcript, the locale, which
 *   tier parsed it, the platform/app version and a client timestamp are all that
 *   go, and only admins can read them back (RLS on `voice_attempts`).
 *
 * Reporting must never break the mic, so the whole thing is fire-and-forget:
 * every failure — no session, no network, a store that refuses — is swallowed
 * and degrades to "not reported" rather than throwing into the voice flow.
 */

import Constants from 'expo-constants';
import { Platform } from 'react-native';

import { backend, backendConfigured } from '@/lib/backend';
import { sessionReplayConsent } from '@/lib/sessionReplay';

export interface VoiceAttempt {
  /** What speech-to-text returned, verbatim — the thing worth revisiting. */
  transcript: string;
  /** How many expenses the parse produced. Zero is the miss we report. */
  itemCount: number;
  /** Whether the model tier (BYOK) produced this, vs the on-device heuristic. */
  usedModel: boolean;
  /** The reader's UI language, so a miss can be read in the script it was said in. */
  locale: string;
}

/**
 * Report one attempt to the backend, best-effort. Sends only unparsed attempts
 * and only with analytics consent; never throws — a failure just means this
 * attempt is not reported.
 */
export async function logVoiceAttempt(entry: VoiceAttempt): Promise<void> {
  try {
    // Only misses carry a signal worth sending. A successful parse stays on the
    // device — there is nothing to improve about speech we already understood.
    if (entry.itemCount !== 0) return;

    const transcript = entry.transcript.trim();
    if (!transcript) return;

    // Nothing to send to, on a build with no backend configured.
    if (!backendConfigured) return;

    // Gate on the same opt-in the session-replay switch records. Speech is
    // sensitive; it leaves the device only for someone who has turned analytics
    // on, and never by default. (See the PR note: on a build without a Clarity
    // project this is always false, so nothing is reported at all.)
    if (!(await sessionReplayConsent())) return;

    // The caller is resolved from the JWT inside the RPC — no id is sent from
    // here. `item_count` is always 0 for what we store, but it is passed
    // explicitly so the column reflects what the client actually saw.
    await backend.rpc('baaki_log_voice_attempt', {
      p_transcript: transcript,
      p_locale: entry.locale,
      p_used_model: entry.usedModel,
      p_item_count: entry.itemCount,
      p_platform: Platform.OS,
      p_app_version: Constants.expoConfig?.version ?? null,
      p_client_at: new Date().toISOString(),
    });
  } catch {
    // Reporting is best-effort — a missing session, no network, or an unwritable
    // store must not break dictation.
  }
}
