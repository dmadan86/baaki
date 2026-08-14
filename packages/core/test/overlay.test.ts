/**
 * The pending overlay for everything that is not an expense.
 *
 * Expenses were the only thing the app could create without a network, so they
 * were the only thing replayed over the mirror. Once every mutation queues, the
 * rest have to appear too — a settlement recorded in a basement, a friend added
 * on a plane, a group started in a tunnel. A row that sits in the queue without
 * appearing is indistinguishable from one the app threw away, which is the
 * failure ADR-005 exists to prevent.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  emptyMirror,
  enqueue,
  materialiseGroups,
  materialiseMembers,
  materialiseSettlements,
  MutationKind,
  reconcile,
  SyncTable,
  type MutationEnvelope,
  type QueuedMutation,
} from '../src/sync/index.js';

const GROUP = 'g-1';
const AT = '2026-03-01T09:00:00Z';

function envelope(
  id: string,
  kind: MutationEnvelope['kind'],
  payload: Record<string, unknown>,
  groupId = GROUP,
): MutationEnvelope {
  return { clientMutationId: id, kind, groupId, clientCreatedAt: AT, payload };
}

function queued(...envelopes: MutationEnvelope[]): QueuedMutation[] {
  let queue: QueuedMutation[] = [];
  for (const item of envelopes) queue = enqueue(queue, item);
  return queue;
}

describe('settlements', () => {
  const settle = envelope('m-1', MutationKind.SettlementCreate, {
    settlementId: 's-1',
    from: 'member-a',
    to: 'member-b',
    currency: 'INR',
    amount: '42000',
    method: 'upi',
    rail: 'upi',
  });

  it('shows a settlement recorded with no network, marked as unsent', () => {
    const rows = materialiseSettlements(emptyMirror(), queued(settle), { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 's-1',
      from_member_id: 'member-a',
      to_member_id: 'member-b',
      amount: '42000',
      pending: true,
    });
  });

  it('never claims the other person has agreed', () => {
    // `initiated`, not `confirmed`: a settlement that confirmed itself on the
    // way out of the phone would clear a debt nobody acknowledged (ADR-007).
    const [row] = materialiseSettlements(emptyMirror(), queued(settle), { groupId: GROUP });
    expect(row?.status).toBe('initiated');
    expect(row?.confirmed_at).toBeNull();
  });

  it('applies a queued confirmation to a settlement the server already sent', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.Settlements,
        groupId: GROUP,
        seq: 1,
        row: {
          id: 's-9',
          group_id: GROUP,
          from_member_id: 'member-a',
          to_member_id: 'member-b',
          currency: 'INR',
          amount: '1000',
          status: 'initiated',
          initiated_at: AT,
          confirmed_at: null,
        },
      },
    ]).state;

    const queue = queued(envelope('m-2', MutationKind.SettlementTransition, { settlementId: 's-9' }));
    const [row] = materialiseSettlements(mirror, queue, { groupId: GROUP });
    expect(row).toMatchObject({ id: 's-9', status: 'confirmed', pending: true });
  });

  it('leaves another group alone', () => {
    const elsewhere = queued(
      envelope(
        'm-3',
        MutationKind.SettlementCreate,
        { ...(settle.payload as Record<string, unknown>), settlementId: 's-2' },
        'g-2',
      ),
    );
    expect(materialiseSettlements(emptyMirror(), elsewhere, { groupId: GROUP })).toHaveLength(0);
  });
});

describe('members', () => {
  it('shows a ghost added offline, with the address that lets them claim later', () => {
    const queue = queued(
      envelope('m-1', MutationKind.MemberAddGhost, {
        memberId: 'mem-1',
        name: 'Ravi',
        email: 'ravi@example.com',
        phone: null,
      }),
    );
    const rows = materialiseMembers(emptyMirror(), queue, { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'mem-1',
      ghost_name: 'Ravi',
      invite_email: 'ravi@example.com',
      profile_id: null,
      pending: true,
    });
  });

  it('does not duplicate somebody the server has since confirmed', () => {
    // Same id both sides — the client chose it, so the row the server sends
    // back replaces the queued one rather than sitting beside it.
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.GroupMembers,
        groupId: GROUP,
        seq: 1,
        row: {
          id: 'mem-1',
          group_id: GROUP,
          profile_id: null,
          ghost_name: 'Ravi',
          left_at: null,
        },
      },
    ]).state;

    const queue = queued(envelope('m-1', MutationKind.MemberAddGhost, { memberId: 'mem-1', name: 'Ravi' }));
    const rows = materialiseMembers(mirror, queue, { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBeUndefined();
  });
});

describe('groups', () => {
  const create = envelope('m-1', MutationKind.GroupCreate, {
    name: 'Goa',
    currency: 'INR',
    emoji: '🏖️',
    country: 'IN',
  });

  it('shows a group started offline, under the id its expenses already name', () => {
    const rows = materialiseGroups(emptyMirror(), queued(create));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: GROUP,
      name: 'Goa',
      default_currency: 'INR',
      country_code: 'IN',
      pending: true,
    });
  });

  it('replays an edit over the row the server sent', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.Groups,
        groupId: GROUP,
        seq: 1,
        row: {
          id: GROUP,
          name: 'Goa',
          default_currency: 'INR',
          created_at: AT,
          archived_at: null,
        },
      },
    ]).state;

    const queue = queued(envelope('m-2', MutationKind.GroupUpdate, { name: 'Goa 2026' }));
    const [row] = materialiseGroups(mirror, queue);
    expect(row).toMatchObject({ id: GROUP, name: 'Goa 2026', pending: true });
  });

  it('keeps an archived group out, however it was archived', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.Groups,
        groupId: GROUP,
        seq: 1,
        row: { id: GROUP, name: 'Old', default_currency: 'INR', created_at: AT, archived_at: AT },
      },
    ]).state;
    expect(materialiseGroups(mirror, [])).toHaveLength(0);
  });
});

describe('the overlay as a whole', () => {
  it('never loses or duplicates a queued row, whatever order it was queued in', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.string({ minLength: 1, maxLength: 6 }), {
          minLength: 0,
          maxLength: 8,
        }),
        (ids) => {
          const queue = queued(
            ...ids.map((id) =>
              envelope(`m-${id}`, MutationKind.SettlementCreate, {
                settlementId: `s-${id}`,
                from: 'a',
                to: 'b',
                currency: 'INR',
                amount: '100',
                method: 'cash',
              }),
            ),
          );

          const rows = materialiseSettlements(emptyMirror(), queue, { groupId: GROUP });
          expect(rows).toHaveLength(ids.length);
          expect(new Set(rows.map((row) => row.id)).size).toBe(ids.length);
          expect(rows.every((row) => row.pending === true)).toBe(true);
        },
      ),
    );
  });
});
