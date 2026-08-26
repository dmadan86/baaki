import { groupByDay } from '@/data/activity';
import type { CaptureRow } from '@/data/types';
import { voiceBatchId } from '@/lib/captureBatch';

/** A day's captures, with same-batch ones folded together in first-seen order. */
export type CaptureInboxItem =
  { kind: 'single'; capture: CaptureRow } | { kind: 'batch'; id: string; items: CaptureRow[] };

export type CaptureFeedItem = { kind: 'day'; key: string; createdAt: string } | CaptureInboxItem;

/** Groups captures from the same voice batch while preserving their first-seen position. */
export function foldCaptureBatches(entries: readonly CaptureRow[]): CaptureInboxItem[] {
  const out: CaptureInboxItem[] = [];
  const at = new Map<string, number>();
  for (const capture of entries) {
    const id = voiceBatchId(capture);
    if (!id) {
      out.push({ kind: 'single', capture });
      continue;
    }
    const index = at.get(id);
    if (index === undefined) {
      at.set(id, out.length);
      out.push({ kind: 'batch', id, items: [capture] });
    } else {
      (out[index] as { items: CaptureRow[] }).items.push(capture);
    }
  }
  return out.map((item) =>
    item.kind === 'batch' && item.items.length === 1
      ? { kind: 'single', capture: item.items[0]! }
      : item,
  );
}

/** Flattens captures into FlashList rows while preserving day headings and voice batches. */
export function buildCaptureFeedItems(rows: readonly CaptureRow[]): CaptureFeedItem[] {
  const items: CaptureFeedItem[] = [];
  for (const section of groupByDay(rows)) {
    const first = section.entries[0];
    if (!first) continue;
    items.push({ kind: 'day', key: `day-${section.key}`, createdAt: first.created_at });
    items.push(...foldCaptureBatches(section.entries));
  }
  return items;
}
