/**
 * Who may use the model-powered features, and how — the rule alone.
 *
 * One rule, three outcomes:
 *   - a paid plan runs them on Baaki's managed key ('paid');
 *   - otherwise a key the reader brought runs them on that key ('byok');
 *   - with neither, the feature is off and shows as disabled ('locked').
 *
 * Kept free of any import so it can be unit-tested without a renderer, the
 * network, or react-native — the hook that feeds it live inputs lives next door
 * in {@link aiAccess} and re-exports these.
 */

/** The resolved verdict. 'loading' until both inputs are known. */
export type AiAccess = 'loading' | 'paid' | 'byok' | 'locked';

export interface AiAccessInputs {
  /** True on a paid plan; undefined while the answer is still in flight. */
  isPaid: boolean | undefined;
  /** How many providers hold a key on this device; undefined while loading. */
  keyCount: number | undefined;
}

/**
 * The rule as a pure function of its two inputs. Paid wins outright — a paid
 * reader is never asked for a key. Failing that, one stored key is enough.
 * Failing both, locked.
 */
export function resolveAiAccess({ isPaid, keyCount }: AiAccessInputs): AiAccess {
  if (isPaid === undefined || keyCount === undefined) return 'loading';
  if (isPaid) return 'paid';
  return keyCount > 0 ? 'byok' : 'locked';
}

/** Whether the features may run at all — paid or a key present. */
export function aiEnabled(access: AiAccess): boolean {
  return access === 'paid' || access === 'byok';
}
