/**
 * The reader's cloud-STT entitlement shape, and the rule for choosing the cloud
 * tier over the on-device fallback (A48, Phase 1).
 *
 * The entitlement is PER PERSON: a paid person has unlimited cloud STT, a free
 * person has a monthly allowance, and a groupmate being paid changes nothing.
 * The server (`baaki_my_voice_access`) is the source of truth; the `useVoiceAccess`
 * hook (in `@/data/hooks`) reads it, and this turns it into a mode. The actual
 * cloud STT call arrives in Phase 2 — this seam lets the UI show "X:XX free left"
 * and lets the picker decide which recogniser to use, before the provider wiring
 * exists.
 *
 * Kept free of React and the backend client so the whole decision is one pure,
 * unit-testable function.
 */

/** The shape `baaki_my_voice_access` returns (already camelCase jsonb). */
export interface VoiceAccess {
  paid: boolean;
  freeSeconds: number;
  usedSeconds: number;
  /** Seconds of cloud STT left this month, or null when unlimited (paid). */
  remainingSeconds: number | null;
  /** The metering period, 'YYYY-MM'. */
  period: string;
}

/** Which recogniser a spoken capture should use. */
export type VoiceMode = 'cloud' | 'basic';

/**
 * Choose the cloud STT tier or the on-device fallback. Pure, so the whole rule
 * is one testable function:
 *
 *  - offline, or cloud STT switched off (the feature flag / no provider): basic;
 *  - no entitlement loaded yet: basic (never gamble a paid call on unknown state);
 *  - paid, or unlimited (remaining null): cloud;
 *  - free with allowance left: cloud; free and spent: basic.
 *
 * "basic" is always safe — it is the on-device recogniser, which needs no
 * network and no third-party call.
 */
export function pickVoiceMode(
  access: VoiceAccess | null | undefined,
  ctx: { online: boolean; cloudEnabled: boolean },
): VoiceMode {
  if (!ctx.online || !ctx.cloudEnabled || !access) return 'basic';
  if (access.paid || access.remainingSeconds === null) return 'cloud';
  return access.remainingSeconds > 0 ? 'cloud' : 'basic';
}
