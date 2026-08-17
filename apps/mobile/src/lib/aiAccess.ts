/**
 * The live AI-access verdict for this device and account.
 *
 * The rule itself is in {@link aiAccessRule} (pure, tested). This wires it to
 * real inputs: the paid signal and the count of keys on the device. The features
 * that read this — receipt OCR, voice-to-expense — are built on top of it next,
 * and share this one definition of "may I" rather than each re-deriving it.
 */

import { useEffect, useState } from 'react';

import { canUploadGroupPhoto } from '@/data/api';
import { configuredAiProviders, subscribeAiKeys } from '@/lib/aiKeys';
import { resolveAiAccess, type AiAccess } from '@/lib/aiAccessRule';

export { aiEnabled, resolveAiAccess } from '@/lib/aiAccessRule';
export type { AiAccess, AiAccessInputs } from '@/lib/aiAccessRule';

/**
 * The paid signal is `canUploadGroupPhoto(null)`: with no group it answers "is
 * the caller paid" through the same SECURITY DEFINER path the photo gate uses
 * (over `baaki_profile_is_paid`, A39) — the one question about your own plan the
 * client can ask today without a new endpoint, and it is exactly this one. When
 * a subscription till exists this is where a dedicated entitlement read would
 * slot in; nothing above it changes.
 *
 * Every mounted consumer subscribes to the shared key-change signal
 * ({@link subscribeAiKeys}), so a save or a remove — wherever it happens —
 * re-reads the inputs and moves the verdict without a remount. The re-read keeps
 * the current values while in flight rather than dropping back to `loading`, so
 * the line does not flicker.
 */
export function useAiAccess(): AiAccess {
  const [isPaid, setIsPaid] = useState<boolean | undefined>(undefined);
  const [keyCount, setKeyCount] = useState<number | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

  // A key mutation anywhere bumps the nonce, re-running the read below.
  useEffect(() => subscribeAiKeys(() => setNonce((current) => current + 1)), []);

  useEffect(() => {
    let active = true;
    // A failed paid check is not the same as "not paid" — but for a gate it is
    // the safe reading: it never grants access on an unknown, and it still lets
    // a brought key through. So a network miss falls to false, not to a throw
    // that would leave the feature stuck loading.
    void canUploadGroupPhoto(null)
      .then((paid) => active && setIsPaid(paid))
      .catch(() => active && setIsPaid(false));
    void configuredAiProviders()
      .then((ids) => active && setKeyCount(ids.length))
      .catch(() => active && setKeyCount(0));
    return () => {
      active = false;
    };
  }, [nonce]);

  return resolveAiAccess({ isPaid, keyCount });
}
