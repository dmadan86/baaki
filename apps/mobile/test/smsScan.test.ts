/**
 * What a scan turns into a draft, and what it deliberately does not.
 *
 * Two rules are load-bearing here, and both are the kind that fail silently.
 *
 * **A message the app read keeps no text.** Not in the draft, not in the field
 * beside it, not anywhere on the wire. The body has a home now — the device-only
 * store (`lib/smsMessageStore.ts`) — which makes this *more* important rather
 * than less: the temptation to "just carry it along" is now a temptation
 * somebody could act on without noticing they had changed anything.
 *
 * **Only what the app is sure of reaches Review.** A capture syncs and appears
 * on the list of things waiting on a person. Everything the parser half-read
 * stays on the Bank messages screen, where it can be looked at rather than
 * answered. Get this wrong in one direction and Review becomes a place people
 * avoid; get it wrong in the other and a real expense is never mentioned.
 *
 * The scan's wiring — the native read, SQLite, the sync queue — is device code
 * and is not exercised here. These are the decisions it makes.
 */

import { describe, expect, it } from 'vitest';

import { classifySms, SmsKind, type SmsMessage } from '@waves/core';

import { draftsFor, scanMaxCount, scanWindow, ScanScope } from '@/lib/smsScanPlan';

const sms = (body: string, receivedAt = '2026-03-02T10:00:00.000Z'): SmsMessage => ({
  body,
  receivedAt,
  sender: 'AD-HDFCBK',
});

const SWIGGY = 'Rs.1,250.00 debited from a/c XX4471 on 02-03-26 at SWIGGY. UPI Ref: 412703998812';
const CAFE = 'Rs.240 debited at BLUE TOKAI on 03-03-26. Ref: 998877665544';
const SALARY = 'Rs.85,000.00 credited to a/c XX4471 on 01-03-26. Ref: 771122334455';
const CARD_BILL = 'Rs 9,165.71 debited from A/c XX1234 towards your Credit Card bill on 01-03-26';
/** Read, but with no date of its own — so the day is a guess, so it waits. */
const UNDATED = 'Rs.410 debited at NANDUS. Ref: 553311446622';

const rowsFor = (bodies: readonly string[]) => {
  const sorted = classifySms(bodies.map((body) => sms(body)));
  return [...sorted.expenses, ...sorted.income, ...sorted.other];
};

describe('the window a scope asks for', () => {
  it('reaches back a month for a quick scan', () => {
    const window = scanWindow(ScanScope.Recent, Date.parse('2026-03-10T09:00:00.000Z'));
    expect(window).toEqual({ from: '2026-02-09', to: '2026-03-10' });
  });

  it('reaches as far back as a phone could plausibly hold for the other', () => {
    const window = scanWindow(ScanScope.Everything, Date.parse('2026-03-10T09:00:00.000Z'));
    expect(window.to).toBe('2026-03-10');
    expect(Date.parse(window.from)).toBeLessThan(Date.parse('2020-01-01'));
  });

  it('is bounded either way — an unbounded filter is a query with no plan', () => {
    for (const scope of [ScanScope.Recent, ScanScope.Everything]) {
      const window = scanWindow(scope, Date.now());
      expect(window.from <= window.to).toBe(true);
      expect(scanMaxCount(scope)).toBeGreaterThan(0);
    }
  });

  it('lets the complete scan pull more than the quick one', () => {
    expect(scanMaxCount(ScanScope.Everything)).toBeGreaterThan(scanMaxCount(ScanScope.Recent));
  });
});

describe('a message the app read keeps no text', () => {
  const drafts = draftsFor(rowsFor([SWIGGY, CAFE]));

  it('leaves rawText null on every draft', () => {
    expect(drafts.length).toBeGreaterThan(0);
    for (const draft of drafts) expect(draft.rawText).toBeNull();
  });

  it('marks them as having come from the inbox, not from a paste', () => {
    for (const draft of drafts) expect(draft.parsed.channel).toBe('inbox');
  });

  it('puts no part of a message body anywhere in what will be synced', () => {
    // Looking for the text anywhere in the serialised draft rather than naming
    // the one field it is supposed to be absent from: a future field that
    // started carrying the body would fail here too.
    const wire = JSON.stringify(drafts, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(wire).not.toContain('debited');
    expect(wire).not.toContain('XX4471');
    expect(wire).not.toContain('a/c');
    expect(wire).not.toContain('UPI Ref');
    // What it does carry is the facts.
    expect(wire).toContain('SWIGGY');
    expect(wire).toContain('125000');
    expect(wire).toContain('2026-03-02');
  });
});

describe('only what the app is sure of reaches Review', () => {
  it('drafts a clean expense', () => {
    expect(draftsFor(rowsFor([SWIGGY])).map((draft) => draft.description)).toEqual(['SWIGGY']);
  });

  it('does not draft money coming in', () => {
    const rows = rowsFor([SALARY]);
    expect(rows.some((row) => row.kind === SmsKind.Income)).toBe(true);
    expect(draftsFor(rows)).toEqual([]);
  });

  it('does not draft a credit card bill', () => {
    // It is a debit, it is confidently read, and it is not an expense — paying
    // the card is the same money as the purchases the card already made.
    const rows = rowsFor([CARD_BILL]);
    expect(rows.some((row) => row.kind === SmsKind.Other)).toBe(true);
    expect(draftsFor(rows)).toEqual([]);
  });

  it('does not draft an expense whose day had to be guessed', () => {
    // It stays on the Bank messages screen instead. On a trip that is exactly
    // the row that would otherwise land on the wrong day and be believed.
    const rows = rowsFor([UNDATED]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe(SmsKind.Expense);
    expect(rows[0]!.dateInferred).toBe(true);
    expect(draftsFor(rows)).toEqual([]);
  });

  it('takes the confident ones out of a mixed batch and leaves the rest', () => {
    const drafts = draftsFor(rowsFor([SWIGGY, SALARY, CARD_BILL, UNDATED, CAFE]));
    expect(drafts.map((draft) => draft.description).sort()).toEqual(['BLUE TOKAI', 'SWIGGY']);
  });

  it('makes nothing of nothing', () => {
    expect(draftsFor([])).toEqual([]);
  });
});
