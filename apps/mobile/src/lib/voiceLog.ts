/**
 * A small on-device log of voice quick-add attempts, so a real miss can be
 * revisited instead of lost the moment the mic closes.
 *
 * The point is understanding: when someone speaks an expense and nothing usable
 * comes back ("hello, can you please add 500 for tea shop"), we want the actual
 * transcript to look at later and improve the parser against — not a guess at
 * what they might have said. Each attempt records what was heard and whether it
 * produced any expense.
 *
 * Privacy: this never leaves the device. It lives in local storage only, is
 * capped to the most recent {@link MAX_ENTRIES}, and the person can clear it or
 * share it themselves from the settings screen. Nothing is sent anywhere — the
 * same "nothing leaves your phone" rule the rest of the app holds to.
 *
 * Logging must never break the mic, so every operation swallows its own errors
 * and degrades to "no log" rather than throwing into the voice flow.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

const STORAGE_KEY = 'voice:attemptLog';

/** Keep only the most recent attempts — enough to spot a pattern, not a diary. */
export const MAX_ENTRIES = 50;

export interface VoiceAttempt {
  /** ISO timestamp of when the attempt was parsed. */
  at: string;
  /** What speech-to-text returned, verbatim — the thing worth revisiting. */
  transcript: string;
  /** How many expenses the parse produced. Zero is the miss we care about. */
  itemCount: number;
  /** Whether the model tier (BYOK) produced this, vs the on-device heuristic. */
  usedModel: boolean;
}

/**
 * Record one attempt, newest first, capped to {@link MAX_ENTRIES}. Never throws:
 * a storage failure just means this attempt is not logged.
 */
export async function logVoiceAttempt(entry: Omit<VoiceAttempt, 'at'>): Promise<void> {
  try {
    const at = new Date().toISOString();
    const existing = await readVoiceLog();
    const next = [{ at, ...entry }, ...existing].slice(0, MAX_ENTRIES);
    await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Logging is best-effort — a full or unwritable store must not break dictation.
  }
}

/** The log, newest first. Empty on any read/parse failure. */
export async function readVoiceLog(): Promise<VoiceAttempt[]> {
  try {
    const raw = await AsyncStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Defensive: a shape written by an older/newer build is filtered to what we
    // can render, rather than trusted wholesale.
    return parsed.filter(
      (row): row is VoiceAttempt =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as VoiceAttempt).transcript === 'string' &&
        typeof (row as VoiceAttempt).at === 'string',
    );
  } catch {
    return [];
  }
}

/** Drop the whole log. Never throws. */
export async function clearVoiceLog(): Promise<void> {
  try {
    await AsyncStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to do — a failed clear leaves the old log, which is harmless.
  }
}
