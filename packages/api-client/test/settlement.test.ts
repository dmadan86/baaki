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

import { coarseMethod, SettlementMethod } from '../src/index';

describe('coarseMethod', () => {
  it('keeps the four the enum knows', () => {
    expect(coarseMethod('upi')).toBe(SettlementMethod.Upi);
    expect(coarseMethod('cash')).toBe(SettlementMethod.Cash);
    expect(coarseMethod('bank')).toBe(SettlementMethod.Bank);
    expect(coarseMethod('other')).toBe(SettlementMethod.Other);
  });

  it('folds every other rail down to other', () => {
    for (const rail of ['pix', 'paynow', 'promptpay', 'wise', 'zelle', 'venmo', 'revolut']) {
      expect(coarseMethod(rail)).toBe(SettlementMethod.Other);
    }
  });

  it('does not mistake an unknown string for a known method', () => {
    expect(coarseMethod('')).toBe(SettlementMethod.Other);
    expect(coarseMethod('UPI')).toBe(SettlementMethod.Other); // case matters — the enum is lower-case
  });
});
