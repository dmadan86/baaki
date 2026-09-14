/**
 * Drafts into the private ledger — "Just me", from whichever screen offered it.
 *
 * Three screens hold a pile of drafts and a picker asking where they should go,
 * and only one of them — the voice review — could answer "just me". The other
 * two said so in a comment and pinned the row away: *"just me" writes to the
 * personal ledger, which this screen has no path to*. This is that path, so the
 * sentence stops being true and the row can be offered everywhere the question
 * is asked.
 *
 * A personal expense is the simplest thing the app writes. Nobody splits it, so
 * there are no members to resolve, no payer to get wrong, no group currency to
 * reconcile against — the draft's own amount, its own currency, its own day
 * (A48). That is why this planner is so much shorter than `captureBulkAssign`,
 * and it is worth saying out loud: the short one is not the incomplete one.
 *
 * ## The id, and why it is the draft's
 *
 * The record takes the draft's own id. A draft becomes exactly one personal
 * expense, so a run interrupted halfway and retried rewrites the same record
 * rather than filing the same lunch twice — the same reasoning, and the same
 * guarantee, as the expense id in `captureBulkAssign` and `smsPlacement`.
 *
 * ## Pure on purpose
 *
 * The screen owns the queue, the sheet and the toast; this only decides what to
 * write. That is what lets "all of them go, none goes missing, a bad amount is
 * reported rather than skipped" be tested with no device (mobile's vitest
 * renders nothing; see vitest.config.ts).
 */

import { encodeTxn, guessCategory, type CurrencyCode } from '@waves/core';

import type { CaptureRow } from '@/data/types';

/** One draft's personal record, ready to be queued as a `personal.upsert`. */
export interface PersonalWrite {
  /** The draft this closes once the record is on the queue. */
  readonly captureId: string;
  /** The record it becomes — the draft's own id, so a retry appends nothing. */
  readonly recordId: string;
  /** The encoded `data` blob an upsert carries (see `encodeTxn`). */
  readonly data: Record<string, unknown>;
}

export interface PersonalPlan {
  readonly writes: readonly PersonalWrite[];
  /**
   * Drafts that cannot become a record at all — an amount that is not a
   * positive whole number of minor units. Counted as failures and left where
   * they are, never quietly skipped: somebody who sent six and was told six
   * went has no way to notice that five did.
   */
  readonly unusable: readonly CaptureRow[];
}

/** A stored minor-unit amount, or null when the row carries something else. */
function minorAmount(value: string): bigint | null {
  if (!/^-?\d+$/.test(value.trim())) return null;
  try {
    const amount = BigInt(value.trim());
    return amount <= 0n ? null : amount;
  } catch {
    return null;
  }
}

/**
 * What to write so a pile of drafts lands in the private ledger.
 *
 * `fallbackDescription` is what an unnamed draft is called — the same courtesy
 * the voice save does, rather than filing a row with no note at all. It must be
 * a name for the *thing*, never a status: the callers first passed "Saved for
 * later", which is what the inbox calls a draft still waiting, and which reads
 * as a lie on a finished entry that is waiting for nothing. `voice.anExpense`
 * is the one the voice save already uses for exactly this. The
 * category is the draft's own where it has one and a guess from the description
 * where it does not, which is exactly what the add-expense form would have
 * shown had the person opened it to accept its defaults.
 */
export function planPersonalPlacement(input: {
  readonly captures: readonly CaptureRow[];
  readonly fallbackDescription: string;
}): PersonalPlan {
  const writes: PersonalWrite[] = [];
  const unusable: CaptureRow[] = [];

  for (const capture of input.captures) {
    const amount = minorAmount(capture.amount);
    if (amount === null) {
      unusable.push(capture);
      continue;
    }
    const note = capture.description?.trim() || input.fallbackDescription;
    writes.push({
      captureId: capture.id,
      recordId: capture.id,
      data: encodeTxn({
        kind: 'expense',
        amount,
        currency: capture.currency as CurrencyCode,
        category: capture.category ?? guessCategory(note),
        note,
        date: capture.expense_date,
        // Neither applies to a draft filed by hand: it repays no loan, and no
        // recurring rule minted it.
        loanId: null,
        recurringId: null,
      }),
    });
  }

  return { writes, unusable };
}

/**
 * Carry out a plan, one draft at a time — the ordering rule, on its own.
 *
 * The effects are handed in rather than reached for, so the one guarantee that
 * makes this safe can actually be tested: **the record is queued first, and the
 * draft is closed only once that has succeeded.** A draft closed against a
 * record that does not exist is a spend that quietly disappeared, and no amount
 * of care at the call sites enforces that — only this loop does.
 *
 * Each draft is its own attempt. One that refuses does not take the others
 * down, and it is left exactly where it was rather than vanishing into a
 * success message that would be a lie. That is also why a failure is counted
 * rather than thrown: the caller needs to say how many landed *and* how many
 * did not, and a throw would lose the first half.
 */
export interface PersonalOutcome {
  readonly done: string[];
  readonly failed: number;
  /**
   * Why the first failure failed, kept rather than dropped.
   *
   * This used to be a bare `catch {}`, and that was a mistake worth naming: the
   * loop counted a refusal and threw away the only thing that could explain it,
   * so the person was told "couldn't save this — try again in a moment" whether
   * the cause was a dead network (true, retry works) or something permanent
   * (false, retry never works), and nothing reached Sentry either. An error
   * nobody looks at is an error nobody can fix.
   *
   * The first rather than all of them: a pile that fails usually fails for one
   * reason, and the caller has room to say one thing.
   */
  readonly firstError: unknown;
}

export async function runPersonalPlacement(input: {
  readonly plan: PersonalPlan;
  /** Queue the record. Rejecting means the draft is kept. */
  readonly upsert: (write: PersonalWrite) => Promise<unknown>;
  /** Close the draft. Only ever called after `upsert` has resolved. */
  readonly close: (captureId: string) => Promise<unknown>;
}): Promise<PersonalOutcome> {
  const done: string[] = [];
  // A draft whose amount the ledger cannot take never had a write to try, so it
  // starts out already counted as a failure rather than being skipped silently.
  let failed = input.plan.unusable.length;
  let firstError: unknown = undefined;

  for (const write of input.plan.writes) {
    try {
      await input.upsert(write);
      await input.close(write.captureId);
      done.push(write.captureId);
    } catch (caught) {
      failed += 1;
      if (firstError === undefined) firstError = caught;
    }
  }

  return { done, failed, firstError };
}
