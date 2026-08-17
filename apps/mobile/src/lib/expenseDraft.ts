/**
 * Resolving a crash-recovery draft's currency back onto the edit form.
 *
 * `currency` and `fx` were added to the draft after drafts already existed on
 * devices, so a draft written by an older build has them `undefined`. That is
 * not the same as an explicit `null`: `null` is "this expense is in the group's
 * own currency", a real choice the user made, while `undefined` is "this draft
 * predates the field and says nothing". A legacy draft must therefore fall back
 * to the currency the saved expense was actually in, not silently become the
 * group currency and rewrite a foreign expense on the next save.
 */
import type { FxRecord } from '@baaki/core';

/**
 * The currency to seed from a draft. `undefined` (legacy draft) defers to the
 * saved version's currency; an explicit value — including `null` — is honoured.
 */
export function resolveDraftCurrency(
  draftCurrency: string | null | undefined,
  versionCurrency: string | null,
): string | null {
  return draftCurrency === undefined ? versionCurrency : draftCurrency;
}

/**
 * The rate to seed from a draft. The saved read model carries no rate, so a
 * legacy draft has none to recover; only an explicit value survives.
 */
export function resolveDraftFx(draftFx: FxRecord | null | undefined): FxRecord | null {
  return draftFx === undefined ? null : draftFx;
}
