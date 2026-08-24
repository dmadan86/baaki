/**
 * Email import pins: a statement table becomes many candidates, a booking
 * confirmation one, currencies survive, credits are dropped, the same
 * transaction seen twice dedupes, and a plain note yields nothing.
 */

import { describe, expect, it } from 'vitest';

import { CategoryId } from '../src/category/categories';
import { proposeFromEmail } from '../src/import/email';

describe('proposeFromEmail', () => {
  it('reads a multi-row card statement into one candidate per debit', () => {
    const email = [
      'HDFC Bank Card Statement',
      'Date         Description                 Amount',
      '14/03/2026   SWIGGY BANGALORE            INR 420.00 Dr',
      '15/03/2026   MAKEMYTRIP FLIGHTS          INR 8,499.00 Dr',
      '16/03/2026   REFUND AMAZON               INR 300.00 Cr',
      'Closing Balance                          INR 42,000.00',
    ].join('\n');

    const out = proposeFromEmail(email);
    expect(out).toHaveLength(2); // the Cr refund and the balance row are excluded
    expect(out[0]!).toMatchObject({
      at: '2026-03-14T00:00:00.000Z',
      category: CategoryId.Food,
    });
    expect(out[0]!.amount).toEqual({ minor: 42000n, currency: 'INR' });
    expect(out[1]!).toMatchObject({ category: CategoryId.Travel });
    expect(out[1]!.amount).toEqual({ minor: 849900n, currency: 'INR' });
  });

  it('reads a single booking confirmation, taking the date from the header', () => {
    const email = [
      'Booking confirmed — Aug 14, 2026',
      'Your stay at Marriott Goa is confirmed.',
      'Total charged: THB 5,600.00',
    ].join('\n');

    const out = proposeFromEmail(email);
    expect(out).toHaveLength(1);
    expect(out[0]!.amount).toEqual({ minor: 560000n, currency: 'THB' });
    expect(out[0]!.at).toBe('2026-08-14T00:00:00.000Z');
    expect(out[0]!.category).toBe(CategoryId.Stay);
    expect(out[0]!.dateInferred).toBe(true); // the line itself carried no date
  });

  it('handles the currency-after-amount form and multiple currencies', () => {
    const email = ['14/03/2026 UBER  600.00 INR Dr', '15/03/2026 HILTON  120.50 USD Dr'].join('\n');
    const out = proposeFromEmail(email);
    expect(out.map((c) => c.amount.currency)).toEqual(['INR', 'USD']);
    expect(out[1]!.amount.minor).toBe(12050n);
  });

  it('dedupes the same transaction against an already-imported key', () => {
    const email = '14/03/2026 SWIGGY BANGALORE INR 420.00 Dr';
    const first = proposeFromEmail(email);
    expect(first).toHaveLength(1);
    const again = proposeFromEmail(email, { alreadyImported: new Set([first[0]!.dedupeKey]) });
    expect(again).toHaveLength(0);
  });

  it('respects a trip window', () => {
    const email = ['10/03/2026 CAFE INR 200.00 Dr', '14/03/2026 CAFE INR 250.00 Dr'].join('\n');
    const out = proposeFromEmail(email, { from: '2026-03-12', to: '2026-03-20' });
    expect(out).toHaveLength(1);
    expect(out[0]!.at).toBe('2026-03-14T00:00:00.000Z');
  });

  it('returns nothing for a note with no transactions', () => {
    expect(proposeFromEmail('Hey, are we still on for the trip next week?')).toEqual([]);
    expect(proposeFromEmail('')).toEqual([]);
  });
});
