/**
 * The consent behind session replay.
 *
 * `clarity.ts` deliberately keeps no opinion about *whether* to record — it
 * boots paused and exposes `allowSessionReplay` for "whatever decides this" to
 * call. This is that decider: a preference the person sets on the privacy
 * screen, remembered between launches, and re-applied at startup so a recording
 * somebody opted into survives a restart without asking again.
 *
 * The default is off, and off is also every failure: an unreadable store, no
 * Clarity account, a value that was never written. Recording other people's
 * money is the kind of thing that has to be reached for, never arrived at.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { allowSessionReplay, clarityConfigured } from './clarity';

const KEY = 'baaki.session_replay_consent';

/** What the person last chose. False unless they explicitly turned it on. */
export async function sessionReplayConsent(): Promise<boolean> {
  if (!clarityConfigured) return false;
  const saved = await AsyncStorage.getItem(KEY).catch(() => null);
  return saved === 'true';
}

/**
 * Record the choice and act on it in one step, so the switch on screen and the
 * SDK's capture state can never disagree.
 *
 * A failed write throws rather than being swallowed. This is a consent: a switch
 * left showing "on" over a preference that was never stored is a recording
 * somebody believes they allowed and did not, and one showing "off" over a
 * stored "on" resumes recording at the next launch. The caller reverts the
 * switch and says so.
 */
export async function setSessionReplayConsent(allowed: boolean): Promise<void> {
  await AsyncStorage.setItem(KEY, String(allowed));
  await allowSessionReplay(allowed);
}

/**
 * Called once at launch, after `initClarity`. Resumes capture only for someone
 * who had already opted in; everyone else stays paused, which is where
 * `initClarity` left them.
 */
export async function applyStoredSessionReplayConsent(): Promise<void> {
  if (!clarityConfigured) return;
  if (await sessionReplayConsent()) await allowSessionReplay(true);
}
