/**
 * Voice batches, counted the way a person counts them.
 *
 * Several expenses spoken in one breath are stored as several captures that
 * share a `voiceBatchId` (carried inside the existing `parsed` jsonb — no schema
 * change). The inbox folds them into one collapsible row, and every count of
 * "waiting drafts" the app shows — the dashboard badge, the unassigned card —
 * must fold them the same way, or one utterance reads as four pending items.
 * This is the single source of both the id and the folded count.
 */

/** The minimal shape these helpers read — anything carrying a `parsed` blob. */
export interface HasParsed {
  readonly parsed?: unknown;
}

/** The batch id a voice capture carries (in `parsed`), or null when it stands alone. */
export function voiceBatchId(capture: HasParsed): string | null {
  const parsed = capture.parsed;
  if (parsed && typeof parsed === 'object' && 'voiceBatchId' in parsed) {
    const value = (parsed as { voiceBatchId?: unknown }).voiceBatchId;
    return typeof value === 'string' && value ? value : null;
  }
  return null;
}

/**
 * How many drafts a person would say are waiting: each standalone capture is
 * one, and all captures sharing a batch id collapse to one. A batch left with a
 * single surviving member is just that capture again — but the set logic already
 * counts it once, so no special case is needed here.
 */
export function foldedCaptureCount(captures: readonly HasParsed[]): number {
  let singles = 0;
  const batches = new Set<string>();
  for (const capture of captures) {
    const id = voiceBatchId(capture);
    if (id) batches.add(id);
    else singles += 1;
  }
  return singles + batches.size;
}
