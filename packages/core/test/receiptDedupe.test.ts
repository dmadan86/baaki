/**
 * Duplicate detection pins the four cases that matter: the same bill scanned
 * twice (exact), a re-scan that rounds a paisa or spells the café differently
 * (likely), genuinely different bills (no match), and the same digits in a
 * different currency (never a match — ADR-004).
 */

import { describe, expect, it } from 'vitest';

import {
  DuplicateConfidence,
  candidateFromParsed,
  findDuplicateReceipt,
  receiptSignature,
  type DedupeReceipt,
  type DuplicateCandidate,
} from '../src/receipt/dedupe';
import type { ParsedReceipt } from '../src/receipt/types';

const existing: DedupeReceipt[] = [
  { id: 'r1', merchant: 'Blue Sea Café', date: '2026-03-14', currency: 'INR', totalMinor: 120000 },
  { id: 'r2', merchant: 'Taxi', date: '2026-03-14', currency: 'INR', totalMinor: 60000 },
];

const sameBill: DuplicateCandidate = {
  merchant: 'Blue Sea Café',
  date: '2026-03-14',
  currency: 'INR',
  totalMinor: 120000,
};

describe('receiptSignature', () => {
  it('is stable across case and whitespace in the merchant', () => {
    const a = receiptSignature(sameBill);
    const b = receiptSignature({ ...sameBill, merchant: '  blue   sea café ' });
    expect(a).toBe(b);
  });

  it('differs by currency so the same digits never collide', () => {
    expect(receiptSignature(sameBill)).not.toBe(receiptSignature({ ...sameBill, currency: 'THB' }));
  });
});

describe('findDuplicateReceipt', () => {
  it('flags the same bill as an exact duplicate', () => {
    const match = findDuplicateReceipt(sameBill, existing);
    expect(match?.confidence).toBe(DuplicateConfidence.Exact);
    expect(match?.match.id).toBe('r1');
  });

  it('flags a re-scan with a rounded total and a re-spelled merchant as likely', () => {
    const rescan: DuplicateCandidate = {
      merchant: 'blue sea café ', // case + trailing space
      date: '2026-03-14',
      currency: 'INR',
      totalMinor: 120001, // one paisa off
    };
    const match = findDuplicateReceipt(rescan, existing);
    expect(match?.confidence).toBe(DuplicateConfidence.Likely);
    expect(match?.match.id).toBe('r1');
  });

  it('does not match a different day, a different total, or a different currency', () => {
    expect(findDuplicateReceipt({ ...sameBill, date: '2026-03-15' }, existing)).toBeNull();
    expect(findDuplicateReceipt({ ...sameBill, totalMinor: 130000 }, existing)).toBeNull();
    expect(findDuplicateReceipt({ ...sameBill, currency: 'THB' }, existing)).toBeNull();
  });

  it('returns null against an empty ledger', () => {
    expect(findDuplicateReceipt(sameBill, [])).toBeNull();
  });

  it('prefers the tightest total gap, breaking ties by id', () => {
    const dupes: DedupeReceipt[] = [
      { id: 'b', merchant: 'Kiosk', date: '2026-03-14', currency: 'INR', totalMinor: 5001 },
      { id: 'a', merchant: 'Kiosk', date: '2026-03-14', currency: 'INR', totalMinor: 5001 },
    ];
    const candidate: DuplicateCandidate = {
      merchant: 'Kiosk',
      date: '2026-03-14',
      currency: 'INR',
      totalMinor: 5000,
    };
    // Both are one minor unit away; the lower id wins.
    expect(findDuplicateReceipt(candidate, dupes)?.match.id).toBe('a');
  });

  it('reduces a parsed receipt to a candidate', () => {
    const parsed = {
      merchant: 'Blue Sea Café',
      date: '2026-03-14',
      currency: 'INR',
      items: [],
      subtotal: null,
      taxes: [],
      serviceCharge: null,
      tip: null,
      discounts: [],
      grandTotal: 120000,
    } satisfies ParsedReceipt;
    expect(findDuplicateReceipt(candidateFromParsed(parsed), existing)?.match.id).toBe('r1');
  });
});
