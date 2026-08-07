/**
 * Passing a scanned receipt from one screen to the next.
 *
 * Somebody who scans a bill on the add-expense screen and then decides to split
 * it by item should not be asked to photograph it a second time — the scan cost
 * them a moment, cost the group one of its free scans (ADR-011), and the answer
 * is already sitting in memory.
 *
 * The route params cannot carry it: a parsed receipt is a nested object, and a
 * URL is a bad place for one. It goes through the draft store instead, which is
 * already the thing that survives the screen going away (ADR-005), keyed per
 * group so two groups open at once cannot swap bills.
 *
 * It is consumed once and cleared. A receipt left lying in the store would
 * pre-fill the itemize screen days later for somebody who came to type a bill
 * in by hand, which is worse than making them scan again.
 */

import type { ParsedReceipt } from '@baaki/core';

export interface ReceiptHandover {
  readonly parsed: ParsedReceipt;
  /**
   * The receipt row the scan was recorded against. Carried across so a bill
   * scanned on the add-expense screen can still be shared with the table from
   * the itemize screen — without it, following the handover meant losing the
   * only thing that makes the lines shareable.
   */
  readonly receiptId?: string;
  /** Epoch milliseconds. A scan nobody followed up on goes stale (see `HANDOVER_TTL_MS`). */
  readonly at: number;
}

/**
 * How long a scan stays worth handing over. Long enough to cover somebody
 * reading the total, changing their mind and tapping through; short enough that
 * an abandoned scan is not still waiting after lunch.
 */
export const HANDOVER_TTL_MS = 10 * 60 * 1000;

export function handoverKey(groupId: string): string {
  return `receipt-handover:${groupId}`;
}

export function handoverIsFresh(handover: ReceiptHandover, now = Date.now()): boolean {
  return now - handover.at < HANDOVER_TTL_MS && now >= handover.at;
}
