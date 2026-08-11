/**
 * The one piece of logic on the settle write path: turning the fine-grained
 * rail a group actually settled on into the coarse `method` enum the table
 * stores. The rest of `recordSettlement` is a straight pass-through to a
 * SECURITY DEFINER RPC and carries no arithmetic to get wrong.
 *
 * The trap this guards is a *silent* one — a new rail (Pix, Wise) that the enum
 * has never heard of must land as `other`, not throw and not slip in as an
 * invalid enum value, so a group in a new country can still record that it
 * settled. This must give the same answer as the phone's inline mapping, or the
 * two clients would file the same payment under two different methods.
 */

import { describe, expect, it } from 'vitest';

import { coarseMethod } from '../src/index';

describe('coarseMethod', () => {
  it('keeps the four the enum knows', () => {
    expect(coarseMethod('upi')).toBe('upi');
    expect(coarseMethod('cash')).toBe('cash');
    expect(coarseMethod('bank')).toBe('bank');
    expect(coarseMethod('other')).toBe('other');
  });

  it('folds every other rail down to other', () => {
    for (const rail of ['pix', 'paynow', 'promptpay', 'wise', 'zelle', 'venmo', 'revolut']) {
      expect(coarseMethod(rail)).toBe('other');
    }
  });

  it('does not mistake an unknown string for a known method', () => {
    expect(coarseMethod('')).toBe('other');
    expect(coarseMethod('UPI')).toBe('other'); // case matters — the enum is lower-case
  });
});
