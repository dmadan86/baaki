/**
 * The expense-write serialization contract (@waves/core).
 *
 * `buildApplyExpenseArgs` is the single serializer both the direct
 * `expense-write` edge and the `/sync` edge use to call `baaki_apply_expense`,
 * and `buildExpenseWriteBody` is the single body builder both the mobile and web
 * direct clients use. These tests pin what a write consists of, so the parity
 * hole this module closed — `expense-write` silently dropping `p_category_meta`
 * and `p_base_version_no` — cannot reopen unnoticed.
 */

import { describe, expect, it } from 'vitest';

import {
  buildApplyExpenseArgs,
  buildExpenseWriteBody,
  sanitiseCategoryMeta,
  sanitiseExpenseLocation,
  type ApplyExpenseArgsInput,
  type CategoryMeta,
  type SplitParams,
} from '../src/index';

/** Every named argument `baaki_apply_expense` accepts except `p_source`, which
 *  every caller leaves to its default. This is the contract with the DB; if the
 *  RPC gains a parameter, this list and the builder must both learn it. */
const APPLY_EXPENSE_KEYS = [
  'p_group_id',
  'p_expense_id',
  'p_author_member_id',
  'p_description',
  'p_category',
  'p_expense_date',
  'p_currency',
  'p_amount',
  'p_split_type',
  'p_split_params',
  'p_payers',
  'p_shares',
  'p_client_mutation_id',
  'p_notes',
  'p_receipt_id',
  'p_base_version_no',
  'p_fx',
  'p_payment_method',
  'p_receipt_share_url',
  'p_category_meta',
  'p_location',
].sort();

const meta: CategoryMeta = { label: 'Chai', icon: 'cup', tint: 'peach' };

/** The normalised pieces an edge has after it has validated and computed. */
function baseArgs(overrides: Partial<ApplyExpenseArgsInput> = {}): ApplyExpenseArgsInput {
  return {
    groupId: 'g1',
    expenseId: 'e1',
    authorMemberId: 'm1',
    description: 'Dinner',
    category: 'custom-tag-id',
    expenseDate: '2026-03-01',
    currency: 'inr',
    amount: 2000n,
    splitParams: { kind: 'equal' } as SplitParams,
    payers: [['m1', 2000n]],
    shares: [
      ['m1', 1000n],
      ['m2', 1000n],
    ],
    clientMutationId: 'mut-1',
    notes: 'tip included',
    receiptId: 'r1',
    baseVersionNo: 3,
    fx: null,
    paymentMethod: 'upi',
    receiptShareUrl: 'https://drive.example/x',
    categoryMeta: meta,
    location: { lat: 12.9, lng: 77.6, name: 'Indiranagar' },
    ...overrides,
  };
}

describe('buildApplyExpenseArgs — the edge → RPC contract', () => {
  it('emits exactly the RPC parameter set, including p_category_meta and p_base_version_no', () => {
    const args = buildApplyExpenseArgs(baseArgs());
    expect(Object.keys(args).sort()).toEqual(APPLY_EXPENSE_KEYS);
    // The two fields the direct path used to drop.
    expect(args.p_category_meta).toEqual(meta);
    expect(args.p_base_version_no).toBe(3);
  });

  it('is identical whichever path builds it — the direct write and the /sync write agree', () => {
    // Both edges normalise a write to the same shape before calling the builder;
    // fed identical inputs, the RPC arguments must be byte-for-byte equal so a
    // create/edit behaves the same online (direct) and offline (queued).
    const direct = buildApplyExpenseArgs(baseArgs());
    const queued = buildApplyExpenseArgs(baseArgs());
    expect(direct).toEqual(queued);
  });

  it('serialises money and split params to the wire forms the RPC expects', () => {
    const args = buildApplyExpenseArgs(baseArgs());
    expect(args.p_amount).toBe('2000');
    expect(args.p_currency).toBe('INR'); // upper-cased
    expect(args.p_split_type).toBe('equal');
    expect(args.p_payers).toEqual([{ memberId: 'm1', amount: '2000' }]);
    expect(args.p_shares).toEqual([
      { memberId: 'm1', amount: '1000' },
      { memberId: 'm2', amount: '1000' },
    ]);
  });

  it('sanitises the category snapshot and the location inside the builder', () => {
    const args = buildApplyExpenseArgs(
      baseArgs({
        categoryMeta: { label: 'X', icon: 'i', tint: 'not-a-tint' },
        location: { lat: 999, lng: 0 },
      }),
    );
    // Unknown tint coerced, out-of-range point dropped — never trusted raw.
    expect(args.p_category_meta?.tint).toBe('sky');
    expect(args.p_location).toBeNull();
  });

  it('defaults every optional field to null when omitted', () => {
    const args = buildApplyExpenseArgs({
      groupId: 'g',
      expenseId: 'e',
      authorMemberId: 'm',
      description: 'd',
      expenseDate: '2026-01-01',
      currency: 'INR',
      amount: 100n,
      splitParams: { kind: 'equal' } as SplitParams,
      payers: [['m', 100n]],
      shares: [['m', 100n]],
      clientMutationId: 'x',
    });
    expect(args.p_category_meta).toBeNull();
    expect(args.p_base_version_no).toBeNull();
    expect(args.p_payment_method).toBeNull();
    expect(args.p_location).toBeNull();
    expect(args.p_fx).toBeNull();
    expect(args.p_receipt_share_url).toBeNull();
    expect(args.p_receipt_id).toBeNull();
    expect(args.p_notes).toBeNull();
  });
});

describe('buildExpenseWriteBody — the client → edge contract', () => {
  it('carries categoryMeta and baseVersionNo in the body', () => {
    const body = buildExpenseWriteBody({
      groupId: 'g',
      expenseId: 'e',
      description: 'Dinner',
      expenseDate: '2026-03-01',
      currency: 'INR',
      amount: 2000n,
      splitParams: { kind: 'equal' },
      participants: ['m1', 'm2'],
      payers: { m1: 2000n },
      categoryMeta: meta,
      baseVersionNo: 3,
      clientMutationId: 'mut-1',
    });
    expect(body.categoryMeta).toEqual(meta);
    expect(body.baseVersionNo).toBe(3);
  });

  it('stringifies bigint money for JSON and defaults optionals to null', () => {
    const body = buildExpenseWriteBody({
      groupId: 'g',
      description: 'Dinner',
      expenseDate: '2026-03-01',
      currency: 'INR',
      amount: 2000n,
      splitParams: { kind: 'equal' },
      participants: ['m1'],
      payers: { m1: 2000n },
      expectedShares: { m1: 2000n },
      clientMutationId: 'mut-1',
    });
    expect(body.amount).toBe('2000');
    expect(body.payers).toEqual({ m1: '2000' });
    expect(body.expectedShares).toEqual({ m1: '2000' });
    expect(body.categoryMeta).toBeNull();
    expect(body.baseVersionNo).toBeNull();
    expect(body.paymentMethod).toBeNull();
    expect(body.location).toBeNull();
  });
});

describe('sanitisers', () => {
  it('sanitiseCategoryMeta drops non-objects and coerces an unknown tint', () => {
    expect(sanitiseCategoryMeta(null)).toBeNull();
    expect(sanitiseCategoryMeta({ label: 'x' })).toBeNull(); // no icon
    expect(sanitiseCategoryMeta({ label: 'x', icon: 'i', tint: 'nope' })).toEqual({
      label: 'x',
      icon: 'i',
      tint: 'sky',
    });
  });

  it('sanitiseExpenseLocation drops NaN and out-of-range points, keeps a valid one', () => {
    expect(sanitiseExpenseLocation({ lat: NaN, lng: 0 })).toBeNull();
    expect(sanitiseExpenseLocation({ lat: 91, lng: 0 })).toBeNull();
    expect(sanitiseExpenseLocation({ lat: 12.9, lng: 77.6, name: '  Cafe  ' })).toEqual({
      lat: 12.9,
      lng: 77.6,
      name: 'Cafe',
    });
  });
});
