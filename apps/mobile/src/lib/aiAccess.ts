/**
 * The live AI-access verdict for this device and account.
 *
 * The rule itself is in {@link aiAccessRule} (pure, tested). This wires it to
 * real inputs: the paid signal and the count of keys on the device. The features
 * that read this — receipt OCR, voice-to-expense — are built on top of it next,
 * and share this one definition of "may I" rather than each re-deriving it.
 */

import { useCallback, useEffect, useState } from 'react';

import { canUploadGroupPhoto } from '@/data/api';
import { configuredAiProviders } from '@/lib/aiKeys';
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
 * `refresh` re-reads the inputs so a screen that just changed a key — saved one,
 * removed one — sees the verdict move without a remount. It keeps the current
 * values while the re-read is in flight rather than dropping back to `loading`,
 * so the line does not flicker on every save.
 */
export function useAiAccess(): { access: AiAccess; refresh: () => void } {
  const [isPaid, setIsPaid] = useState<boolean | undefined>(undefined);
  const [keyCount, setKeyCount] = useState<number | undefined>(undefined);
  const [nonce, setNonce] = useState(0);

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

  const refresh = useCallback(() => setNonce((current) => current + 1), []);

  return { access: resolveAiAccess({ isPaid, keyCount }), refresh };
}
