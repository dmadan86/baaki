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
  materialiseCaptures,
  materialiseGroups,
  materialiseMemberBudgets,
  materialiseMembers,
  materialisePlanItems,
  materialiseSettlements,
  MutationKind,
  openCaptures,
  openPlanItems,
  reconcile,
  SyncTable,
  type MutationEnvelope,
  type QueuedMutation,
  type SyncChange,
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

    const queue = queued(
      envelope('m-2', MutationKind.SettlementTransition, { settlementId: 's-9' }),
    );
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

    const queue = queued(
      envelope('m-1', MutationKind.MemberAddGhost, { memberId: 'mem-1', name: 'Ravi' }),
    );
    const rows = materialiseMembers(mirror, queue, { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBeUndefined();
  });

  it('shows the creator of a group started offline, under the id the client chose', () => {
    // Without this a group made offline has no members until it syncs, so an
    // expense queued behind it (an add-person IOU) has no "me" to name.
    const queue = queued(
      envelope('m-1', MutationKind.GroupCreate, {
        name: 'Ravi',
        currency: 'INR',
        creatorMemberId: 'me-1',
        creatorProfileId: 'profile-1',
      }),
    );
    const rows = materialiseMembers(emptyMirror(), queue, { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'me-1',
      profile_id: 'profile-1',
      ghost_name: null,
      role: 'admin',
      pending: true,
    });
  });

  it('shows both the creator and the ghost of an add-person IOU built offline', () => {
    const queue = queued(
      envelope('m-1', MutationKind.GroupCreate, {
        name: 'Ravi',
        currency: 'INR',
        creatorMemberId: 'me-1',
        creatorProfileId: 'profile-1',
      }),
      envelope('m-2', MutationKind.MemberAddGhost, { memberId: 'ghost-1', name: 'Ravi' }),
    );
    const rows = materialiseMembers(emptyMirror(), queue, { groupId: GROUP });
    expect(rows.map((row) => row.id).sort()).toEqual(['ghost-1', 'me-1']);
    expect(rows.find((row) => row.id === 'me-1')?.profile_id).toBe('profile-1');
    expect(rows.find((row) => row.id === 'ghost-1')?.profile_id).toBeNull();
  });

  it('does not duplicate the creator once the server has confirmed it', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.GroupMembers,
        groupId: GROUP,
        seq: 1,
        row: {
          id: 'me-1',
          group_id: GROUP,
          profile_id: 'profile-1',
          ghost_name: null,
          left_at: null,
        },
      },
    ]).state;
    const queue = queued(
      envelope('m-1', MutationKind.GroupCreate, {
        name: 'Ravi',
        currency: 'INR',
        creatorMemberId: 'me-1',
        creatorProfileId: 'profile-1',
      }),
    );
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

// ─────────────────────────────────────────────────── captures (A34) ──
//
// A capture rides a *personal* scope: the envelope's groupId slot holds the
// owner's user id. These check the overlay behaves under that scope and that the
// inbox filter (`openCaptures`) hides what has been assigned or deleted.

describe('captures', () => {
  const OWNER = 'user-1';

  const create = envelope(
    'c-1',
    MutationKind.CaptureCreate,
    {
      captureId: 'cap-1',
      description: 'Petrol',
      category: 'transport',
      expenseDate: '2026-03-01',
      currency: 'INR',
      amount: '250000',
    },
    OWNER,
  );

  it('shows a capture made with no network, marked unsent', () => {
    const rows = materialiseCaptures(emptyMirror(), queued(create), { ownerId: OWNER });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'cap-1',
      description: 'Petrol',
      amount: '250000',
      status: 'open',
      pending: true,
    });
    expect(openCaptures(rows)).toHaveLength(1);
  });

  it('is invisible under a different owner — the scope is the person', () => {
    const rows = materialiseCaptures(emptyMirror(), queued(create), { ownerId: 'someone-else' });
    expect(rows).toHaveLength(0);
  });

  it('merges an offline edit onto the same capture', () => {
    const update = envelope(
      'c-2',
      MutationKind.CaptureUpdate,
      {
        captureId: 'cap-1',
        description: 'Petrol — highway',
        expenseDate: '2026-03-01',
        currency: 'INR',
        amount: '260000',
      },
      OWNER,
    );
    const rows = materialiseCaptures(emptyMirror(), queued(create, update), { ownerId: OWNER });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'Petrol — highway', amount: '260000' });
  });

  it('drops a deleted capture from the inbox', () => {
    const remove = envelope('c-3', MutationKind.CaptureDelete, { captureId: 'cap-1' }, OWNER);
    const rows = materialiseCaptures(emptyMirror(), queued(create, remove), { ownerId: OWNER });
    expect(openCaptures(rows)).toHaveLength(0);
  });

  it('drops an assigned capture from the inbox but keeps the record', () => {
    const assign = envelope(
      'c-4',
      MutationKind.CaptureAssign,
      { captureId: 'cap-1', groupId: 'g-9', expenseId: 'e-9' },
      OWNER,
    );
    const rows = materialiseCaptures(emptyMirror(), queued(create, assign), { ownerId: OWNER });
    expect(openCaptures(rows)).toHaveLength(0);
    expect(rows[0]).toMatchObject({
      status: 'assigned',
      assigned_group_id: 'g-9',
      assigned_expense_id: 'e-9',
    });
  });

  it('overlays a queued edit on a server row, keyed by the owner scope', () => {
    const serverRow: SyncChange = {
      table: SyncTable.Captures,
      groupId: OWNER,
      seq: 1,
      row: {
        id: 'cap-1',
        owner_user_id: OWNER,
        description: 'Petrol',
        category: 'transport',
        expense_date: '2026-03-01',
        currency: 'INR',
        amount: '250000',
        notes: null,
        photo_path: null,
        raw_text: null,
        parsed: null,
        status: 'open',
        assigned_expense_id: null,
        assigned_group_id: null,
        created_at: AT,
        deleted_at: null,
      },
    };
    const { state } = reconcile(emptyMirror(), [serverRow]);
    const edit = envelope(
      'c-5',
      MutationKind.CaptureUpdate,
      {
        captureId: 'cap-1',
        description: 'Petrol (edited)',
        expenseDate: '2026-03-01',
        currency: 'INR',
        amount: '250000',
      },
      OWNER,
    );
    const rows = materialiseCaptures(state, queued(edit), { ownerId: OWNER });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'Petrol (edited)', pending: true });
  });
});

describe('trip plan (A23)', () => {
  const create = envelope('p-1', MutationKind.PlanItemCreate, {
    itemId: 'item-1',
    day: '2026-03-14',
    title: 'Scuba dive',
    currency: 'INR',
  });

  it('shows a plan item added with no network, marked pending', () => {
    const rows = materialisePlanItems(emptyMirror(), queued(create), { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: 'item-1',
      title: 'Scuba dive',
      day: '2026-03-14',
      done_at: null,
      deleted_at: null,
      pending: true,
    });
  });

  it('ticks an item done, and back undone', () => {
    const done = envelope('p-2', MutationKind.PlanItemUpdate, { itemId: 'item-1', done: true });
    const [row] = materialisePlanItems(emptyMirror(), queued(create, done), { groupId: GROUP });
    expect(row?.done_at).not.toBeNull();

    const undone = envelope('p-3', MutationKind.PlanItemUpdate, { itemId: 'item-1', done: false });
    const [row2] = materialisePlanItems(emptyMirror(), queued(create, done, undone), {
      groupId: GROUP,
    });
    expect(row2?.done_at).toBeNull();
  });

  it('removes an item — soft-deleted, so openPlanItems drops it', () => {
    const remove = envelope('p-4', MutationKind.PlanItemDelete, { itemId: 'item-1' });
    const all = materialisePlanItems(emptyMirror(), queued(create, remove), { groupId: GROUP });
    expect(all[0]?.deleted_at).not.toBeNull();
    // The screen reads openPlanItems, so a removed item is simply gone from it.
    expect(openPlanItems(all)).toHaveLength(0);
  });

  it('sorts by day then position, with a fresh offline item after the known ones', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.TripPlanItems,
        groupId: GROUP,
        seq: 1,
        row: {
          id: 'server-1',
          group_id: GROUP,
          day: '2026-03-14',
          title: 'Breakfast',
          position: 0,
          currency: 'INR',
          done_at: null,
          deleted_at: null,
        },
      },
    ]).state;
    const rows = openPlanItems(materialisePlanItems(mirror, queued(create), { groupId: GROUP }));
    // Same day: the server item (position 0) before the pending one (last).
    expect(rows.map((r) => r.id)).toEqual(['server-1', 'item-1']);
  });

  it('does not duplicate an item the server has since confirmed', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.TripPlanItems,
        groupId: GROUP,
        seq: 1,
        row: {
          id: 'item-1',
          group_id: GROUP,
          day: '2026-03-14',
          title: 'Scuba dive',
          position: 0,
          currency: 'INR',
          done_at: null,
          deleted_at: null,
        },
      },
    ]).state;
    const rows = materialisePlanItems(mirror, queued(create), { groupId: GROUP });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.pending).toBeUndefined();
  });

  it('leaves another group’s plan alone', () => {
    const elsewhere = envelope(
      'p-9',
      MutationKind.PlanItemCreate,
      { itemId: 'item-2', day: '2026-03-14', title: 'X', currency: 'INR' },
      'g-2',
    );
    expect(materialisePlanItems(emptyMirror(), queued(elsewhere), { groupId: GROUP })).toHaveLength(
      0,
    );
  });
});

describe('trip member budgets (A23)', () => {
  const ME = 'me-1';
  const set = envelope('b-1', MutationKind.MemberBudgetSet, {
    amountMinor: '500000',
    currency: 'INR',
    visibility: 'private',
  });

  it('shows my budget set offline, keyed to my member id', () => {
    const rows = materialiseMemberBudgets(emptyMirror(), queued(set), {
      groupId: GROUP,
      myMemberId: ME,
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      member_id: ME,
      amount_minor: '500000',
      visibility: 'private',
      pending: true,
    });
  });

  it('clears my budget — soft-deleted, so it drops out of the list', () => {
    const clear = envelope('b-2', MutationKind.MemberBudgetClear, {});
    const rows = materialiseMemberBudgets(emptyMirror(), queued(set, clear), {
      groupId: GROUP,
      myMemberId: ME,
    });
    expect(rows).toHaveLength(0);
  });

  it('overwrites my existing budget rather than adding a second', () => {
    const mirror = reconcile(emptyMirror(), [
      {
        table: SyncTable.TripMemberBudgets,
        groupId: GROUP,
        seq: 1,
        row: {
          id: 'bud-1',
          group_id: GROUP,
          member_id: ME,
          amount_minor: '100000',
          currency: 'INR',
          visibility: 'private',
          deleted_at: null,
        },
      },
    ]).state;
    const rows = materialiseMemberBudgets(mirror, queued(set), { groupId: GROUP, myMemberId: ME });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.amount_minor).toBe('500000');
    expect(rows[0]?.id).toBe('bud-1'); // same row, raised
  });

  it('does not overlay anything when the caller has no member id', () => {
    const rows = materialiseMemberBudgets(emptyMirror(), queued(set), {
      groupId: GROUP,
      myMemberId: null,
    });
    expect(rows).toHaveLength(0);
  });
});

describe('overall trip budget rides the group row', () => {
  const base: SyncChange = {
    table: SyncTable.Groups,
    groupId: GROUP,
    seq: 1,
    row: {
      id: GROUP,
      name: 'Goa',
      default_currency: 'INR',
      created_at: AT,
      archived_at: null,
      budget_minor: null,
      budget_currency: null,
    },
  };

  it('sets the overall budget optimistically on the group', () => {
    const mirror = reconcile(emptyMirror(), [base]).state;
    const set = envelope('g-1', MutationKind.GroupBudgetSet, {
      amountMinor: '2000000',
      currency: 'INR',
    });
    const [row] = materialiseGroups(mirror, queued(set));
    expect(row).toMatchObject({ budget_minor: '2000000', budget_currency: 'INR', pending: true });
  });

  it('clears the overall budget with a null amount', () => {
    const withBudget = reconcile(emptyMirror(), [
      { ...base, row: { ...base.row, budget_minor: '2000000', budget_currency: 'INR' } },
    ]).state;
    const clear = envelope('g-2', MutationKind.GroupBudgetSet, { amountMinor: null });
    const [row] = materialiseGroups(withBudget, queued(clear));
    expect(row?.budget_minor).toBeNull();
    expect(row?.budget_currency).toBeNull();
  });
});
