/**
 * The two things the automatic reader has to remember between launches.
 *
 * ## `lastCheckedAt` — when the inbox was last looked at
 *
 * It is the whole of the battery story. Without it every pass would sweep
 * ninety days, an hour at a time, forever; with it a pass reads the day or two
 * since the last one and nothing else. It is also the sentence the Review
 * screen shows ("… · 2 min ago"), so it has to be *true* rather than
 * approximately true: it is written by the background task exactly as it is
 * written by a foreground read, and it advances only when a read actually
 * succeeded (`smsAutoReadPass.ts` decides that; this only stores the answer).
 *
 * Owner-scoped, like the backup settings and the capture nudge. A device is not
 * always one person's, and "we last read your messages an hour ago" said to the
 * second account on a shared phone would be a lie about work done for somebody
 * else.
 *
 * ## `armed` — whose phone this is, for the background task
 *
 * The hourly pass runs in a headless JavaScript context with no React tree, so
 * it cannot ask `useAuth` who is signed in or `useFlagVariant` which arm they
 * are on — the flag arrives over the network and the session lives behind an
 * async keystore read. What it *can* do is read one key that the foreground
 * wrote the last time it evaluated the gates in full.
 *
 * So `armed` is the foreground's signed statement: "as of the last time the app
 * was open, this account passed every gate". It is written when the reader goes
 * live and removed the moment it does not — the flag switched off, permission
 * revoked, a sign-out — and the background task treats its absence as an
 * instruction to unregister itself. The gates are still re-checked inside the
 * task (platform, build, permission); this only supplies the two facts a
 * headless context cannot discover on its own.
 *
 * It holds an account id and nothing else. No message, no merchant, no count.
 *
 * Nothing here rejects. Storage refusing to answer must not switch a feature on
 * that was off, so every read fails towards "not armed, never checked".
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

/** When this account's inbox was last read. One slot per account. */
const LAST_CHECKED_KEY = 'waves.sms_auto_read.last_checked_at';
/**
 * The account the background task should work for, or absent for "nobody".
 *
 * Device-level rather than owner-scoped on purpose: the task has no owner to
 * scope by until it reads this, which is the entire reason it exists.
 */
const ARMED_KEY = 'waves.sms_auto_read.armed';

const scoped = (ownerId: string): string => `${LAST_CHECKED_KEY}.${ownerId}`;

/** A plausible ISO instant, or null. Garbage reads as "never checked". */
function asInstant(stored: string | null): string | null {
  if (!stored) return null;
  const stamp = Date.parse(stored);
  return Number.isFinite(stamp) ? new Date(stamp).toISOString() : null;
}

/** When this account's inbox was last read, or null if it never has been. */
export async function loadLastCheckedAt(ownerId: string): Promise<string | null> {
  if (!ownerId) return null;
  return asInstant(await AsyncStorage.getItem(scoped(ownerId)).catch(() => null));
}

/**
 * Remember that the inbox was read up to this instant.
 *
 * Best effort: a write that fails costs one repeated read of a day already
 * read, which the stable capture id makes a no-op anyway.
 */
export async function saveLastCheckedAt(ownerId: string, at: string): Promise<void> {
  if (!ownerId) return;
  await AsyncStorage.setItem(scoped(ownerId), at).catch(() => {});
}

/** The account the background task should read for, or null for nobody. */
export async function loadArmedOwner(): Promise<string | null> {
  const stored = await AsyncStorage.getItem(ARMED_KEY).catch(() => null);
  return stored && stored.trim() ? stored : null;
}

/** Arm the background task for this account. Called only when every gate passed. */
export async function armAutoRead(ownerId: string): Promise<void> {
  if (!ownerId) return;
  await AsyncStorage.setItem(ARMED_KEY, ownerId).catch(() => {});
}

/**
 * Disarm. Called the instant a gate shuts, and on the way out of an account.
 *
 * Unregistering the task is a separate step and both happen together — see
 * `smsAutoReadTask.ts`. This one is the durable half: a task that somehow
 * survives the unregister finds nothing to work for and stands itself down.
 */
export async function disarmAutoRead(): Promise<void> {
  await AsyncStorage.removeItem(ARMED_KEY).catch(() => {});
}

/**
 * Forget everything about an account's automatic reading.
 *
 * For erasure, not for signing out: the timestamp is how a returning account
 * avoids re-reading ninety days it has already read, and there is nothing
 * private in "the inbox was last looked at on Tuesday".
 */
export async function clearAutoReadState(ownerId: string): Promise<void> {
  await disarmAutoRead();
  if (!ownerId) return;
  await AsyncStorage.removeItem(scoped(ownerId)).catch(() => {});
}

// ──────────────────────────────────────── the grant, as it happens ──

type GrantListener = () => void;
const grantListeners = new Set<GrantListener>();

/**
 * Somebody just granted `READ_SMS`.
 *
 * Called by `smsReader.readSms` when a read comes back having actually
 * happened, which is the only moment in the app at which the Android dialog can
 * have been answered "allow". It exists because that dialog does not move
 * `AppState` — the app never leaves the foreground for it — so the reader would
 * otherwise not notice the grant until the next cold start, and the ninety-day
 * backfill is precisely the thing that must not wait that long.
 *
 * Deliberately here, in the leaf module, rather than in `smsAutoRead.ts`:
 * `smsReader` may not import the driver (the driver imports it), and a listener
 * registry with no imports of its own is the smallest thing that breaks the
 * cycle.
 */
export function noteSmsPermissionGranted(): void {
  for (const listener of [...grantListeners]) {
    try {
      listener();
    } catch {
      // A reader that cannot start is not a reason for a read that worked to
      // report failure to the screen that asked for it.
    }
  }
}

/** Listen for that. Returns the unsubscribe. */
export function onSmsPermissionGranted(listener: GrantListener): () => void {
  grantListeners.add(listener);
  return () => grantListeners.delete(listener);
}
