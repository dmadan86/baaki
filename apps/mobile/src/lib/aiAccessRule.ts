/**
 * Who may use the model-powered features, and how — the rule alone.
 *
 * One rule, resolved top to bottom:
 *   - a paid plan runs them on Baaki's managed key ('paid');
 *   - otherwise a brought key that is switched on and under its token ceiling
 *     runs them on that key ('byok');
 *   - a brought key switched off is 'paused' — present, but not in use;
 *   - a brought key that has hit its token ceiling is 'overlimit';
 *   - with no key at all, the feature is off and shows as disabled ('locked').
 *
 * 'paused', 'overlimit' and 'locked' all mean the features do not run, but they
 * are distinct so the screen can say *why* and offer the right fix — flip the
 * switch, raise the limit, or add a key.
 *
 * Kept free of any import so it can be unit-tested without a renderer, the
 * network, or react-native — the hook that feeds it live inputs lives next door
 * in {@link aiAccess} and re-exports these.
 */

/** The resolved verdict. 'loading' until the inputs it needs are known. */
export type AiAccess = 'loading' | 'paid' | 'byok' | 'paused' | 'overlimit' | 'locked';

export interface AiAccessInputs {
  /** True on a paid plan; undefined while the answer is still in flight. */
  isPaid: boolean | undefined;
  /** How many providers hold a key on this device; undefined while loading. */
  keyCount: number | undefined;
  /** Whether the brought key is switched on; undefined while loading. */
  keyEnabled: boolean | undefined;
  /** Whether the brought key has reached its token ceiling; undefined while loading. */
  overLimit: boolean | undefined;
}

/**
 * The rule as a pure function of its inputs. Paid wins outright — a paid reader
 * is never asked for a key, and the switch and the ceiling are the brought key's
 * concern, not theirs. Failing paid, a key must be present, on, and under budget
 * to run; each of those failing has its own verdict.
 */
export function resolveAiAccess({
  isPaid,
  keyCount,
  keyEnabled,
  overLimit,
}: AiAccessInputs): AiAccess {
  if (isPaid === undefined || keyCount === undefined) return 'loading';
  if (isPaid) return 'paid';
  if (keyCount > 0) {
    // The key's own settings only matter once we know a key exists.
    if (keyEnabled === undefined || overLimit === undefined) return 'loading';
    if (!keyEnabled) return 'paused';
    if (overLimit) return 'overlimit';
    return 'byok';
  }
  return 'locked';
}

/** Whether the features may run at all — paid, or a key that is present, on and under budget. */
export function aiEnabled(access: AiAccess): boolean {
  return access === 'paid' || access === 'byok';
}
