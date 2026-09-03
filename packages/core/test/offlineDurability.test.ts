/**
 * What survives when the offline queue holds something the app cannot use.
 *
 * ADR-005 promises that a change is safe the moment it is saved on the phone.
 * Two failures broke that promise in opposite directions, and both are asserted
 * here:
 *
 *  1. A queued mutation the overlay cannot materialise threw out of a
 *     render-time `useMemo`. The payload is on disk, so the throw repeated on
 *     every launch — a crash loop the user cannot escape without reinstalling,
 *     which takes the rest of the queue with it.
 *  2. A mutation that exhausts `MAX_ATTEMPTS` stops being sent and blocks
 *     everything queued behind it in its group. `deadLettered` has always
 *     described that set; nothing ever called it, so the app said "sending 1
 *     change…" forever and offered no way out.
 */

import { describe, expect, it } from 'vitest';

import {
  backoffMs,
  deadLettered,
  discard,
  enqueue,
  markFailed,
  MAX_ATTEMPTS,
  MutationKind,
  nextBatch,
  overlayPending,
  parseAmount,
  retryNow,
  type MirrorExpense,
  type MutationEnvelope,
  type QueuedMutation,
} from '../src/sync/index.js';

const GROUP = 'group-1';
const OTHER = 'group-2';

const envelope = (
  id: string,
  payload: Record<string, unknown>,
  groupId = GROUP,
): MutationEnvelope => ({
  clientMutationId: id,
  kind: MutationKind.ExpenseCreate,
  groupId,
  clientCreatedAt: '2026-03-01T00:00:00.000Z',
  payload,
});

const goodPayload = (expenseId: string) => ({
  expenseId,
  description: 'Chai',
  expenseDate: '2026-03-01',
  currency: 'INR',
  amount: '900',
  splitParams: { kind: 'equal' },
  participants: ['m1', 'm2'],
  payers: { m1: '900' },
});

/** The shape a build from six months ago, or a truncated write, can leave
 *  behind: everything the overlay reads is present, and the amount is not a
 *  number. `parseAmount` raises a typed MoneyError on it. */
const badPayload = (expenseId: string) => ({
  ...goodPayload(expenseId),
  amount: 'nine hundred',
});

const queued = (envelopes: readonly MutationEnvelope[]): QueuedMutation[] =>
  envelopes.reduce<QueuedMutation[]>((queue, item) => enqueue(queue, item), []);

describe('a queued mutation the overlay cannot materialise', () => {
  it('really is unparseable — the tests below are not asserting a no-op', () => {
    // `pendingShares` calls exactly this on the queued payload's amount. If it
    // ever stopped throwing, every test below would pass for the wrong reason.
    expect(() => parseAmount(badPayload('e1').amount)).toThrow();
  });

  it('is dropped, and every other queued expense still renders', () => {
    const queue = queued([
      envelope('m-good-1', goodPayload('e1')),
      envelope('m-bad', badPayload('e2')),
      envelope('m-good-2', goodPayload('e3')),
    ]);

    const rows = overlayPending([], queue, { groupId: GROUP });

    expect(rows.map((row) => row.id).sort()).toEqual(['e1', 'e3']);
    expect(rows.every((row) => row.pending)).toBe(true);
  });

  it('leaves the server rows it was overlaying untouched', () => {
    const server: MirrorExpense[] = [
      {
        id: 'e-server',
        group_id: GROUP,
        deleted_at: null,
        created_at: '2026-02-01T00:00:00.000Z',
        currentVersion: {
          id: 'v1',
          version_no: 1,
          description: 'Dinner',
          category: null,
          category_meta: null,
          expense_date: '2026-02-01',
          currency: 'INR',
          amount: '1000',
          split_type: 'equal',
          split_params: { kind: 'equal' },
          author_member_id: 'm1',
          notes: null,
          payment_method: null,
          receipt_share_url: null,
          location: null,
          created_at: '2026-02-01T00:00:00.000Z',
          payers: [{ member_id: 'm1', amount: '1000' }],
          shares: [
            { member_id: 'm1', amount: '500' },
            { member_id: 'm2', amount: '500' },
          ],
        },
      } as MirrorExpense,
    ];

    const rows = overlayPending(server, queued([envelope('m-bad', badPayload('e2'))]), {
      groupId: GROUP,
    });

    // The whole point: one bad queue entry must not take the ledger with it.
    expect(rows).toEqual(server);
  });

  it('drops only the bad mutation, not the later edits of other expenses', () => {
    const queue = queued([
      envelope('m-bad', badPayload('e1')),
      envelope('m-good', goodPayload('e2')),
    ]);
    // An update after the bad create, on a different expense, still applies.
    const withUpdate: QueuedMutation[] = [
      ...queue,
      {
        ...envelope('m-update', { ...goodPayload('e2'), description: 'Chai, again' }),
        kind: MutationKind.ExpenseUpdate,
        seq: 3,
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
      },
    ];

    const rows = overlayPending([], withUpdate, { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.currentVersion?.description).toBe('Chai, again');
  });
});

describe('a mutation that has stopped retrying', () => {
  /** Fail the whole queue until it gives up — how a dead transport really does
   *  it: the batch goes out together and comes back failed together. */
  const exhaust = (queue: QueuedMutation[]): QueuedMutation[] => {
    let current = queue;
    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
      // Far enough past each backoff that the batch is eligible again.
      const now = attempt * backoffMs(MAX_ATTEMPTS);
      current = markFailed(current, nextBatch(current, { now }), 'network', now);
    }
    return current;
  };

  /** One mutation already at a given attempt count — the state the queue is
   *  actually restored into from disk, without replaying the failures. */
  const at = (id: string, attempts: number, groupId = GROUP): QueuedMutation => ({
    ...envelope(id, goodPayload(`e-${id}`), groupId),
    seq: Number(id.replace(/\D/g, '')),
    attempts,
    nextAttemptAt: attempts === 0 ? 0 : backoffMs(attempts),
    lastError: attempts === 0 ? null : 'network',
  });

  it('reaches the ceiling through ordinary transport failures', () => {
    const exhausted = exhaust(queued([envelope('m1', goodPayload('e1'))]));

    expect(exhausted[0]?.attempts).toBe(MAX_ATTEMPTS);
    expect(deadLettered(exhausted).map((item) => item.clientMutationId)).toEqual(['m1']);
    // ~8.5 minutes of trying, and then nothing ever again without a person.
    expect(nextBatch(exhausted, { now: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });

  it('blocks its own group and nothing else — which is why it needs surfacing', () => {
    const queue = [at('m1', MAX_ATTEMPTS), at('m2', 0, OTHER)];

    const stuck = deadLettered(queue);
    expect(stuck).toHaveLength(1);
    expect(stuck[0]?.groupId).toBe(GROUP);

    // The other group keeps syncing, so the app never looks broken — which is
    // exactly how this stayed invisible.
    const later = nextBatch(queue, { now: Number.MAX_SAFE_INTEGER });
    expect(later.map((item) => item.clientMutationId)).toEqual(['m2']);
  });

  it('holds everything queued behind it in the same group', () => {
    const queue = [at('m1', MAX_ATTEMPTS), at('m2', 0)];

    // `m2` never left the phone, so it is not itself dead — it is just stuck,
    // and there was nothing on screen to say so.
    expect(deadLettered(queue).map((item) => item.clientMutationId)).toEqual(['m1']);
    expect(nextBatch(queue, { now: Number.MAX_SAFE_INTEGER })).toEqual([]);
  });

  it('moves again once the user retries the head', () => {
    const queue = [at('m1', MAX_ATTEMPTS), at('m2', 0)];

    // The banner acts on the head, because within a group that is the one row
    // blocking the rest.
    const head = deadLettered(queue)[0];
    const retried = retryNow(queue, head?.clientMutationId ?? '');

    expect(deadLettered(retried)).toEqual([]);
    expect(nextBatch(retried, { now: 0 }).map((item) => item.clientMutationId)).toEqual([
      'm1',
      'm2',
    ]);
  });

  it('moves again once the user discards the head', () => {
    const queue = [at('m1', MAX_ATTEMPTS), at('m2', 0)];

    const head = deadLettered(queue)[0];
    const dropped = discard(queue, head?.clientMutationId ?? '');

    expect(deadLettered(dropped)).toEqual([]);
    expect(nextBatch(dropped, { now: 0 }).map((item) => item.clientMutationId)).toEqual(['m2']);
  });
});
