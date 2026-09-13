/**
 * Ticked bank messages into one group, in one go.
 *
 * The Review screen already knows how to put a pile of drafts into a group:
 * everybody in, split equally, the person doing it down as having paid — the
 * add-expense form's own defaults, written without opening the form, because
 * opening a form per row to accept its defaults is exactly the work the gesture
 * exists to remove. That decision lives in `captureBulkAssign.planCaptureAssign`
 * and it is not repeated here.
 *
 * What is here is the adapter. A row on the Bank messages screen is not a
 * capture — most of them never became one, deliberately, because only the
 * confident expenses go to Review (`smsScanPlan.draftsFor`). So a ticked row is
 * dressed as the shape the planner reads, and the planner decides the rest.
 * One function builds the expense for both screens, which is the only way "a
 * message placed from here" and "a draft placed from Review" can be guaranteed
 * to produce the same ledger row.
 *
 * ## The id, and why it is derived
 *
 * The expense takes the id `smsCaptureId` derives from the account and the
 * message's own dedupe key. It is therefore the same id every time, for that
 * message, on that account, on any phone. A half-finished run retried writes
 * the same row again rather than a second copy of the same dinner, and two
 * phones reading one inbox agree without talking to each other.
 *
 * It is also, deliberately, the same id the *capture* for that message would
 * have. Those are different tables and cannot collide, and having one id lets
 * the placement close the capture — the one in Review — without looking it up.
 *
 * ## What the group never gets
 *
 * The message. `rawText` is null on everything built here, as it is everywhere
 * a read message is involved; `lib/smsDrafts.ts` states that rule and
 * `lib/smsMessageStore.ts` is where the body actually lives, on this device.
 * The expense carries the shop, the amount and the day, which is what an
 * expense is.
 */

import { guessCategory } from '@waves/core';

import type { CaptureRow } from '@/data/types';

import { merchantName } from './smsPlain';
import type { StoredSms } from './smsMessageTypes';

/**
 * A stored message dressed as the capture the planner reads.
 *
 * Only the fields `planCaptureAssign` actually looks at carry meaning — the id,
 * the amount, the currency, the description, the category, the day, how it was
 * paid and where. The rest are filled with the empty values a draft made from a
 * message would have had, rather than left undefined, so the object is a real
 * `CaptureRow` and cannot surprise a future reader of the planner.
 */
export function smsRowAsCapture(row: StoredSms, ownerId: string, id: string): CaptureRow {
  // The same guard the row's own title uses, so a payment shown as "Payment
  // from Axis Bank" cannot arrive in a group's ledger named 9215676766.
  const description = merchantName(row.merchant) ?? '';
  return {
    id,
    owner_user_id: ownerId,
    description,
    category: description ? guessCategory(description) : null,
    category_meta: null,
    expense_date: row.occurredOn,
    currency: row.currency,
    amount: row.amount,
    notes: null,
    photo_path: null,
    // Never the message. Not here, not anywhere a read message is involved.
    raw_text: null,
    parsed: {
      source: 'sms',
      channel: 'inbox',
      sender: row.sender,
      dedupeKey: row.dedupeKey,
      confidence: row.confidence,
      accountTail: row.accountTail,
      dateInferred: row.dateInferred,
    },
    payment_method: null,
    target_group_id: null,
    location: null,
    status: 'open' as CaptureRow['status'],
    assigned_expense_id: null,
    assigned_group_id: null,
    created_at: row.readAt,
  };
}

/**
 * Rows that can become an expense, and rows that cannot.
 *
 * A row whose amount is not a positive whole number of minor units has no
 * expense to write — a parser bug, rare, and it must be *reported* rather than
 * quietly skipped, because a person who ticked six and was told six were placed
 * has no way to notice that five were.
 */
export function splitPlaceable(rows: readonly StoredSms[]): {
  placeable: StoredSms[];
  unusable: StoredSms[];
} {
  const placeable: StoredSms[] = [];
  const unusable: StoredSms[] = [];
  for (const row of rows) {
    if (!/^\d+$/.test(row.amount.trim()) || BigInt(row.amount.trim()) <= 0n) unusable.push(row);
    else placeable.push(row);
  }
  return { placeable, unusable };
}
