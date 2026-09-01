/**
 * Saying who paid.
 *
 * Two regressions live here. A list row that named `payers[0]` put a shared
 * bill entirely on one person; an audit trail that compared only the set of
 * names lost an edit that moved money between payers without changing the
 * total. Both are decisions over plain rows, so both are checked here rather
 * than on a screen.
 */

import { describe, expect, it } from 'vitest';

import { paidBy, payerAuditText, payerFactsKey } from '@/lib/payerLines';

const rows = (pairs: [string, string][]) =>
  pairs.map(([member_id, amount]) => ({ member_id, amount }));
const nameOf = (id: string | null) => (id === null ? 'Someone' : id.toUpperCase());
const rupees = (minor: bigint) => `₹${(Number(minor) / 100).toFixed(2)}`;

describe('paidBy', () => {
  it('names one payer and credits what they put in', () => {
    expect(paidBy(rows([['asha', '100000']]))).toEqual({
      kind: 'one',
      memberId: 'asha',
      amount: 100000n,
    });
  });

  it('counts several, and totals what they put in between them', () => {
    // The bug: this row used to read "Asha paid" over a bill Asha and Ravi
    // split — the whole thing on whoever happened to sort first.
    expect(
      paidBy(
        rows([
          ['asha', '60000'],
          ['ravi', '40000'],
        ]),
      ),
    ).toEqual({ kind: 'several', count: 2, amount: 100000n });
  });

  it('treats a version with no payer rows as one unnamed payer', () => {
    expect(paidBy([])).toEqual({ kind: 'one', memberId: null, amount: 0n });
  });
});

describe('payerFactsKey', () => {
  it('changes when money moves between payers on an unchanged total', () => {
    // 600/400 → 500/500. Same total, so no amount line; same names, so the old
    // name-only comparison showed nothing at all.
    const before = payerFactsKey(
      rows([
        ['asha', '60000'],
        ['ravi', '40000'],
      ]),
    );
    const after = payerFactsKey(
      rows([
        ['asha', '50000'],
        ['ravi', '50000'],
      ]),
    );
    expect(before).not.toBe(after);
  });

  it('changes when the payers do', () => {
    expect(payerFactsKey(rows([['asha', '100000']]))).not.toBe(
      payerFactsKey(rows([['ravi', '100000']])),
    );
  });

  it('does not change when only the row order does', () => {
    expect(
      payerFactsKey(
        rows([
          ['asha', '60000'],
          ['ravi', '40000'],
        ]),
      ),
    ).toBe(
      payerFactsKey(
        rows([
          ['ravi', '40000'],
          ['asha', '60000'],
        ]),
      ),
    );
  });
});

describe('payerAuditText', () => {
  it('prints the figures when there are several payers', () => {
    expect(
      payerAuditText(
        rows([
          ['asha', '60000'],
          ['ravi', '40000'],
        ]),
        nameOf,
        rupees,
        'None',
      ),
    ).toBe('ASHA ₹600.00, RAVI ₹400.00');
  });

  it('prints one payer as a name — the amount is the bill s own line', () => {
    expect(payerAuditText(rows([['asha', '100000']]), nameOf, rupees, 'None')).toBe('ASHA');
  });

  it('says so when there are none', () => {
    expect(payerAuditText([], nameOf, rupees, 'None')).toBe('None');
  });
});
