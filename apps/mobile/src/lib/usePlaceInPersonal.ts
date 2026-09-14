/**
 * "Just me", carried out — the one write path behind the picker row.
 *
 * Three screens ask where a pile of drafts should go, and until now only the
 * voice review could answer "just me"; the other two pinned the row away
 * because neither had a path to the personal ledger. Rather than growing a
 * second and a third copy of that path, it is here once, and the screens hand
 * over drafts and get back a report.
 *
 * What it owns is deliberately the whole gesture, not half of it: the records,
 * the closing of the drafts they came from, and saying honestly what landed.
 * Splitting those would leave each caller to re-derive the one rule that
 * actually matters — a draft is closed only *after* its record is queued, never
 * before, because a draft closed against a record that does not exist is a
 * spend that quietly disappeared. That rule is the reason this is a hook and
 * not just a planner.
 *
 * Both writes ride the ordinary offline queue (ADR-005), so this works with no
 * network and survives being killed mid-run. Each draft is its own attempt: one
 * that refuses does not take the others down, and it is left where it was
 * rather than vanishing into a success message that would be a lie.
 */

import { useCallback, useRef } from 'react';

import { useDeleteCapture } from '@/data/hooks';
import { useUpsertPersonalRecord } from '@/data/personal';
import type { CaptureRow } from '@/data/types';
import { plural, useStrings } from '@/i18n';
import { useDialog } from '@/lib/dialog';
import { friendlyError } from '@/lib/errors';
import { useGuestGuard } from '@/lib/guestGuard';
import { planPersonalPlacement, runPersonalPlacement } from '@/lib/personalPlacement';
import { useToast } from '@/lib/toast';

/**
 * Returns the ids of the drafts that actually became a record.
 *
 * Not `void`, because one caller has bookkeeping of its own: the Bank messages
 * screen must mark each message answered, and it can only do that for the ones
 * that landed. Saying which is the difference between that screen settling a
 * message whose expense never got written and leaving it to be tried again.
 */
export function usePlaceInPersonal(): (input: {
  /** What the per-target lock is taken on: the row, or the batch's first row. */
  lockKey: string;
  items: readonly CaptureRow[];
}) => Promise<string[]> {
  const { t, locale } = useStrings();
  const upsertPersonal = useUpsertPersonalRecord();
  const deleteCapture = useDeleteCapture();
  const guard = useGuestGuard();
  const toast = useToast();
  const { notify } = useDialog();

  // Per target rather than a single flag, so filing one row never swallows the
  // gesture on the next. Same shape as the group path's lock.
  const placing = useRef<Set<string>>(new Set());

  return useCallback(
    async (input): Promise<string[]> => {
      if (placing.current.has(input.lockKey)) return [];
      // A guest has no account to keep a private ledger in; the guard says so
      // in the same words every other write on these screens uses.
      if (guard.blockWrite()) return [];
      placing.current.add(input.lockKey);
      const done: string[] = [];
      try {
        const plan = planPersonalPlacement({
          captures: input.items,
          fallbackDescription: t.voice.anExpense,
        });

        // The ordering rule lives in `runPersonalPlacement`, where it can be
        // tested: the record is queued first, and the draft is closed only once
        // that has succeeded. Closing it by deletion rather than
        // `capture.assign` is deliberate — that mutation records a group and an
        // expense id, and a personal expense has neither.
        const outcome = await runPersonalPlacement({
          plan,
          upsert: (write) =>
            upsertPersonal.mutateAsync({
              recordId: write.recordId,
              recordKind: 'txn',
              data: write.data,
            }),
          close: (captureId) => deleteCapture.mutateAsync(captureId),
        });
        done.push(...outcome.done);
        const failed = outcome.failed;

        const placed = done.length;
        if (failed === 0) {
          if (placed > 0) toast.show(plural(locale, placed, t.captures.placedInPersonal));
          return done;
        }
        // Something did not land, so this is said in a dialog rather than a
        // toast that fades: it names how many are still waiting, and (when some
        // did land) how many did, so neither half of a partial run is implied.
        const lines: string[] = [];
        if (placed > 0) lines.push(plural(locale, placed, t.captures.placedInPersonal));
        lines.push(plural(locale, failed, t.captures.assignBatchSomeFailed));
        await notify({ title: t.captures.title, body: lines.join('\n\n') });
        return done;
      } catch (caught) {
        // The callers fire this without awaiting, so anything the planning step
        // throws would otherwise leave with no word to the person whose drafts
        // are still sitting there. A toast rather than a dialog: the drafts are
        // exactly where they were, so there is nothing to answer.
        toast.show(friendlyError(caught, t.captures.couldNotSave, 'captures.personal'), 'negative');
        return done;
      } finally {
        placing.current.delete(input.lockKey);
      }
    },
    [deleteCapture, guard, locale, notify, t, toast, upsertPersonal],
  );
}
