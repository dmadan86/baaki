/**
 * The live AI-access verdict for this device and account.
 *
 * The rule itself is in {@link aiAccessRule} (pure, tested). This wires it to
 * real inputs: the paid signal, the count of keys on the device, and the key's
 * own settings — whether it is switched on and whether it has spent its token
 * ceiling. The features that read this — receipt OCR, voice-to-expense — are
 * built on top of it next, and share this one definition of "may I".
 */

import { useEffect, useState } from 'react';

import { canUploadGroupPhoto } from '@/data/api';
import { subscribeAiConfig } from '@/lib/aiEvents';
import { configuredAiProviders } from '@/lib/aiKeys';
import { getAiSettings, isOverAiLimit } from '@/lib/aiSettings';
import { resolveAiAccess, type AiAccess, type AiAccessInputs } from '@/lib/aiAccessRule';

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
 * Every mounted consumer subscribes to the shared config signal
 * ({@link subscribeAiConfig}), so a key saved or removed, the key paused, or a
 * changed token limit re-reads the inputs and moves the verdict without a
 * remount. The re-read keeps the current values while in flight rather than
 * dropping back to `loading`, so the line does not flicker.
 */
export function useAiAccess(): AiAccess {
  const [inputs, setInputs] = useState<AiAccessInputs>({
    isPaid: undefined,
    keyCount: undefined,
    keyEnabled: undefined,
    overLimit: undefined,
  });
  const [nonce, setNonce] = useState(0);

  // A key or settings mutation anywhere bumps the nonce, re-running the read below.
  useEffect(() => subscribeAiConfig(() => setNonce((current) => current + 1)), []);

  useEffect(() => {
    let active = true;
    const set = (patch: Partial<AiAccessInputs>): void => {
      if (active) setInputs((current) => ({ ...current, ...patch }));
    };
    // A failed paid check is not the same as "not paid" — but for a gate it is
    // the safe reading: it never grants access on an unknown, and it still lets
    // a brought key through. So a network miss falls to false, not to a throw
    // that would leave the feature stuck loading.
    void canUploadGroupPhoto(null)
      .then((paid) => set({ isPaid: paid }))
      .catch(() => set({ isPaid: false }));
    void configuredAiProviders()
      .then((ids) => set({ keyCount: ids.length }))
      .catch(() => set({ keyCount: 0 }));
    // getAiSettings never throws, but keep the shape uniform.
    void getAiSettings()
      .then((settings) => set({ keyEnabled: settings.enabled, overLimit: isOverAiLimit(settings) }))
      .catch(() => set({ keyEnabled: true, overLimit: false }));
    return () => {
      active = false;
    };
  }, [nonce]);

  return resolveAiAccess(inputs);
}
