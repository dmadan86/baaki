/**
 * The dashboard's one-time offer to bring a Drive backup back.
 *
 * The happy path is the least interesting thing here. What is worth pinning
 * down is every way the offer must *not* be made — because the failure that
 * matters is not a prompt that never appears, it is one that asks somebody with
 * four hundred records whether they have lost their data. So most of this file
 * is about silence: a phone that already holds a ledger, a build that cannot
 * reach Drive, a count read before anything has been looked at, and an answer
 * that has to outlive an app restart.
 *
 * The dismissal half is exercised against the real store rather than a fake,
 * because "it sticks" is a claim about AsyncStorage keys and their owner
 * scoping, and a fake would be asserting that the test's own map works.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { RestorePromptInput } from '../src/lib/backup/restorePrompt';

// `settings.ts` reaches the sync-network module, which imports expo-network for
// a type-level enum. Nothing here touches a network; this only has to load.
vi.mock('expo-network', () => ({
  NetworkStateType: { WIFI: 'wifi', CELLULAR: 'cellular', NONE: 'none' },
}));

const { restoreOffer, RestoreOffer } = await import('../src/lib/backup/restorePrompt');
const AsyncStorage = (await import('@react-native-async-storage/async-storage')).default;
const { clearBackupSettings, loadRestorePromptDismissed, markRestorePromptDismissed } =
  await import('../src/lib/backup/settings');

/** A signed-in, non-guest, Drive-capable phone that has been fully read. */
const READY: RestorePromptInput = {
  signedIn: true,
  isGuest: false,
  configured: true,
  connected: true,
  recordCount: 0,
  settled: true,
  dismissed: false,
};

const offer = (overrides: Partial<RestorePromptInput> = {}) =>
  restoreOffer({ ...READY, ...overrides });

describe('a phone that already holds the ledger', () => {
  it('is asked nothing at all', () => {
    // The one that matters. A returning user opening Home must never be asked
    // whether they would like their records back — it reads as the app having
    // lost them.
    expect(offer({ recordCount: 1 })).toBe(RestoreOffer.None);
    expect(offer({ recordCount: 412 })).toBe(RestoreOffer.None);
  });

  it('is asked nothing even with no Drive account linked', () => {
    // Having data beats every other consideration, including the one state that
    // most looks like a fresh phone.
    expect(offer({ recordCount: 3, connected: false })).toBe(RestoreOffer.None);
  });
});

describe('before anything has actually been looked at', () => {
  it('says nothing, because a zero count is not yet a claim', () => {
    // Between the mirror hydrating and the session's first sync landing, every
    // phone in the world holds zero personal records. Asking in that window is
    // how somebody with a full ledger gets the prompt.
    expect(offer({ settled: false })).toBe(RestoreOffer.None);
  });

  it('still says nothing when everything else is exactly right', () => {
    expect(offer({ settled: false, connected: false, recordCount: 0 })).toBe(RestoreOffer.None);
  });
});

describe('a build with no Drive client id', () => {
  it('offers nothing, rather than a restore that cannot happen', () => {
    // Every restore path in the app refuses this build with `not-configured`.
    // An offer here would name a backup and then be unable to reach it, which
    // is worse than silence.
    expect(offer({ configured: false })).toBe(RestoreOffer.None);
    expect(offer({ configured: false, connected: false })).toBe(RestoreOffer.None);
  });
});

describe('who is asked', () => {
  it('asks a signed-in person whose phone is empty', () => {
    expect(offer()).toBe(RestoreOffer.Restore);
  });

  it('asks nobody when nobody is signed in', () => {
    expect(offer({ signedIn: false })).toBe(RestoreOffer.None);
  });

  it('does not ask a guest, who has no backup to have made', () => {
    // A guest's records live under an anonymous id that has never had a Drive
    // backup; the question has no true answer for them.
    expect(offer({ isGuest: true })).toBe(RestoreOffer.None);
  });
});

describe('whether Drive is linked', () => {
  it('changes the sentence, never the answer', () => {
    // An unlinked phone is the *most* likely one to want this — it is what a new
    // handset looks like — so the link is a step inside the answer, not a
    // condition on the question.
    expect(offer({ connected: true })).toBe(RestoreOffer.Restore);
    expect(offer({ connected: false })).toBe(RestoreOffer.LinkFirst);
  });

  it('announces the consent sheet when there is nothing linked', () => {
    // `LinkFirst` is what makes the copy say a Google account is about to be
    // asked for. Being handed that sheet unannounced is how a restore turns
    // into "why does it want my Google account".
    expect(offer({ connected: false })).toBe(RestoreOffer.LinkFirst);
  });
});

describe('an answer already given', () => {
  it('is not asked again, whether or not Drive is linked', () => {
    expect(offer({ dismissed: true })).toBe(RestoreOffer.None);
    expect(offer({ dismissed: true, connected: false })).toBe(RestoreOffer.None);
  });
});

// ─────────────────────────────────────────── the dismissal, on disk ──

const A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

beforeEach(async () => {
  await AsyncStorage.clear();
});

describe('dismissing it sticks', () => {
  it('is remembered by a later read — the next render, open or sync', async () => {
    // The whole of "it does not come back": every one of those is a fresh read
    // of this key, and there is no in-memory state behind it to lose.
    expect(await loadRestorePromptDismissed(A)).toBe(false);
    await markRestorePromptDismissed(A);
    expect(await loadRestorePromptDismissed(A)).toBe(true);
    expect(await loadRestorePromptDismissed(A)).toBe(true);
  });

  it('belongs to the account and not to the phone', async () => {
    // A shared handset: A saying "not now" must not silence the offer for B,
    // who has their own backup and has never been asked.
    await markRestorePromptDismissed(A);
    expect(await loadRestorePromptDismissed(B)).toBe(false);
  });

  it('is asked again after a sign-out, which is the boundary it is bounded by', async () => {
    // Deliberate, and the reason the flag lives with the backup settings rather
    // than beside the prompt: `clearBackupSettings` is what sign-out runs, so a
    // dismissal lasts until this device starts fresh for this person again.
    await markRestorePromptDismissed(A);
    await clearBackupSettings(A);
    expect(await loadRestorePromptDismissed(A)).toBe(false);
  });

  it('leaves the other person’s answer alone when one of them signs out', async () => {
    await markRestorePromptDismissed(A);
    await markRestorePromptDismissed(B);
    await clearBackupSettings(A);
    expect(await loadRestorePromptDismissed(A)).toBe(false);
    expect(await loadRestorePromptDismissed(B)).toBe(true);
  });

  it('writes and reads nothing for a signed-out caller', async () => {
    await markRestorePromptDismissed('');
    expect(await AsyncStorage.getAllKeys()).toEqual([]);
    expect(await loadRestorePromptDismissed('')).toBe(false);
  });
});
