/**
 * Reading a bank SMS into a *proposed* expense.
 *
 * The interesting tests here are the refusals. A parser that reads a real debit
 * correctly is table stakes; one that reads an OTP as a ₹5,000 dinner, or books
 * a refund as an expense, or re-proposes something already confirmed, produces
 * wrong money in somebody's ledger from a message they never thought about.
 *
 * Every message below is shaped like one an Indian bank actually sends.
 */

import { describe, expect, it } from 'vitest';

import { SMS_LOW_CONFIDENCE, parseSms, proposeFromSms, type SmsMessage } from '../src/index.js';

const sms = (body: string, receivedAt = '2026-03-02T10:00:00.000Z'): SmsMessage => ({
  body,
  receivedAt,
  sender: 'AD-HDFCBK',
});

describe('a real debit', () => {
  it('reads amount, merchant, reference and date', () => {
    const parsed = parseSms(
      'Rs.1,250.00 debited from a/c XX4471 on 02-03-26 at SWIGGY. UPI Ref: 412703998812. Not you? Call 18002586161',
    );

    expect(parsed).not.toBeNull();
    expect(parsed?.amount.minor).toBe(125000n);
    expect(parsed?.amount.currency).toBe('INR');
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.merchant).toBe('SWIGGY');
    expect(parsed?.accountTail).toBe('4471');
    expect(parsed?.reference).toBe('412703998812');
    expect(parsed?.occurredAt?.slice(0, 10)).toBe('2026-03-02');
    expect(parsed?.confidence).toBeGreaterThanOrEqual(SMS_LOW_CONFIDENCE);
  });

  it('handles the Indian digit grouping', () => {
    // 1,23,456.78 — not 123,456.78. Both must land on the same minor units.
    expect(parseSms('INR 1,23,456.78 debited at HOTEL TAJ')?.amount.minor).toBe(12345678n);
    expect(parseSms('INR 123,456.78 debited at HOTEL TAJ')?.amount.minor).toBe(12345678n);
  });

  it('reads a whole-rupee amount', () => {
    expect(parseSms('Rs 500 spent at CAFE COFFEE DAY')?.amount.minor).toBe(50000n);
  });

  it('reads a foreign card spend in its own currency', () => {
    const parsed = parseSms('USD 42.50 spent on card XX1234 at STARBUCKS on 04-Aug-26');
    expect(parsed?.amount.currency).toBe('USD');
    expect(parsed?.amount.minor).toBe(4250n);
    expect(parsed?.occurredAt?.slice(0, 10)).toBe('2026-08-04');
  });

  it('reads a named-month date with a time', () => {
    const parsed = parseSms('Rs.900 debited at 05-Aug-2026 14:30 to ANJAPPAR');
    expect(parsed?.occurredAt).toBe('2026-08-05T14:30:00.000Z');
  });
});

describe('messages that must not become expenses', () => {
  it('refuses an OTP, which quotes a real amount from the real bank', () => {
    // The most dangerous false positive in the whole set: right sender, right
    // amount, and a person tapping through would confirm a purchase they were
    // in the middle of *not* making.
    expect(
      parseSms('OTP 448210 for txn of Rs.5,000.00 at AMAZON. Valid 10 min. Do not share.'),
    ).toBeNull();
  });

  it('refuses a payment request, which has not happened yet', () => {
    expect(parseSms('PhonePe: RAVI has requested Rs.800. Approve in the app.')).toBeNull();
    expect(parseSms('Rs.2,499 will be debited on 10-03-26 towards NETFLIX')).toBeNull();
  });

  it('refuses a failed or declined transaction', () => {
    expect(
      parseSms('Txn of Rs.1,200 at BIGBASKET was declined due to insufficient funds'),
    ).toBeNull();
    expect(parseSms('Your payment of Rs.340 to UBER failed. Ref 99182')).toBeNull();
  });

  it('refuses a balance or statement message', () => {
    expect(parseSms('Avl Bal in a/c XX4471 is Rs.42,318.55 as on 02-03-26')).toBeNull();
    expect(parseSms('Your statement for a/c XX4471: total spent Rs.18,200')).toBeNull();
  });

  it('refuses a bill reminder', () => {
    expect(parseSms('Reminder: Rs.3,410 is due on 15-03-26 for card XX1234')).toBeNull();
  });

  it('refuses a message with no amount at all', () => {
    expect(parseSms('Your card XX4471 has been activated.')).toBeNull();
  });

  it('refuses a message that does not say which way the money went', () => {
    // Without a direction word this could be either, and a credit booked as an
    // expense is worse than proposing nothing.
    expect(parseSms('Rs.1,000 txn on a/c XX4471 ref 8812')).toBeNull();
  });

  it('refuses a zero amount', () => {
    expect(parseSms('Rs.0.00 debited at TEST MERCHANT')).toBeNull();
  });
});

describe('money coming in is not an expense', () => {
  it('reads a credit as a credit', () => {
    const parsed = parseSms('Rs.2,000 credited to a/c XX4471 from RAVI on 02-03-26');
    expect(parsed?.direction).toBe('credit');
  });

  it('and never proposes it', () => {
    const proposed = proposeFromSms(
      [
        sms('Rs.2,000 credited to a/c XX4471 from RAVI on 02-03-26'),
        sms('Rs.1,500 refund received for order 88123 on 02-03-26'),
        sms('Rs.750 debited at CAFE on 02-03-26'),
      ],
      { from: '2026-03-01', to: '2026-03-05' },
    );
    expect(proposed).toHaveLength(1);
    expect(proposed[0]?.amount.minor).toBe(75000n);
  });
});

describe('only what happened during the trip', () => {
  const inbox = [
    sms('Rs.400 debited at AIRPORT CAFE on 28-02-26'),
    sms('Rs.1,250 debited at GOA SHACK on 02-03-26'),
    sms('Rs.900 debited at BEACH BAR on 04-03-26'),
    sms('Rs.600 debited at HOME STORE on 09-03-26'),
  ];

  it('keeps only the messages inside the window', () => {
    const proposed = proposeFromSms(inbox, { from: '2026-03-01', to: '2026-03-05' });
    expect(proposed.map((c) => c.merchant)).toEqual(['GOA SHACK', 'BEACH BAR']);
  });

  it('includes both end days in full', () => {
    // A trip "1st to 5th" means all of the 1st and all of the 5th. An expense
    // at 11pm on the last night is not outside the trip.
    const proposed = proposeFromSms(
      [
        sms('Rs.100 debited at LATE BAR on 05-03-26 23:30'),
        sms('Rs.100 debited at DAWN on 01-03-26 00:15'),
      ],
      { from: '2026-03-01', to: '2026-03-05' },
    );
    expect(proposed).toHaveLength(2);
  });

  it('returns them oldest first', () => {
    const proposed = proposeFromSms(inbox, { from: '2026-02-01', to: '2026-03-31' });
    expect(proposed.map((c) => c.at)).toEqual([...proposed.map((c) => c.at)].sort());
  });
});

describe('confirming twice must not double-post', () => {
  it('collapses the same message seen twice', () => {
    const one = sms('Rs.1,250 debited at SWIGGY on 02-03-26. Ref: 412703998812');
    const proposed = proposeFromSms([one, { ...one }], { from: '2026-03-01', to: '2026-03-05' });
    expect(proposed).toHaveLength(1);
  });

  it('drops what was already imported', () => {
    const inbox = [sms('Rs.1,250 debited at SWIGGY on 02-03-26. Ref: 412703998812')];
    const first = proposeFromSms(inbox, { from: '2026-03-01', to: '2026-03-05' });
    expect(first).toHaveLength(1);

    // Re-scanning the inbox after confirming must propose nothing.
    const again = proposeFromSms(inbox, {
      from: '2026-03-01',
      to: '2026-03-05',
      alreadyImported: new Set(first.map((c) => c.dedupeKey)),
    });
    expect(again).toHaveLength(0);
  });

  it('uses the bank reference when there is one, so rewording does not slip through', () => {
    const proposed = proposeFromSms(
      [
        sms('Rs.1,250 debited at SWIGGY on 02-03-26. Ref: 412703998812'),
        sms('INR 1250.00 spent at SWIGGY BANGALORE on 02-03-26. UPI Ref: 412703998812'),
      ],
      { from: '2026-03-01', to: '2026-03-05' },
    );
    expect(proposed).toHaveLength(1);
  });

  it('still separates two genuinely different amounts on the same day', () => {
    const proposed = proposeFromSms(
      [sms('Rs.300 debited at CAFE on 02-03-26'), sms('Rs.700 debited at CAFE on 02-03-26')],
      { from: '2026-03-01', to: '2026-03-05' },
    );
    expect(proposed).toHaveLength(2);
  });
});

describe('what a person is asked to look at', () => {
  it('does not pre-select a message whose date we had to infer', () => {
    // The bank did not say when, so arrival time was used. On a trip that is
    // exactly how an expense lands on the wrong day.
    const proposed = proposeFromSms([sms('Rs.500 debited at CAFE')], {
      from: '2026-03-01',
      to: '2026-03-05',
    });
    expect(proposed[0]?.dateInferred).toBe(true);
    expect(proposed[0]?.preselect).toBe(false);
  });

  it('does not pre-select a message we barely understood', () => {
    const proposed = proposeFromSms([sms('Rs.500 debited on 02-03-26')], {
      from: '2026-03-01',
      to: '2026-03-05',
    });
    expect(proposed[0]?.merchant).toBeNull();
    expect(proposed[0]?.preselect).toBe(false);
  });

  it('pre-selects only a message that was fully understood', () => {
    const proposed = proposeFromSms(
      [sms('Rs.1,250 debited from a/c XX4471 at SWIGGY on 02-03-26. Ref: 412703998812')],
      { from: '2026-03-01', to: '2026-03-05' },
    );
    expect(proposed[0]?.preselect).toBe(true);
    expect(proposed[0]?.dateInferred).toBe(false);
  });

  it('keeps the sender so a person can recognise the bank', () => {
    const proposed = proposeFromSms([sms('Rs.500 debited at CAFE on 02-03-26')], {
      from: '2026-03-01',
      to: '2026-03-05',
    });
    expect(proposed[0]?.sender).toBe('AD-HDFCBK');
  });
});

describe('no float ever exists between the text and the amount (ADR-003)', () => {
  it('parses amounts that a float would round wrong', () => {
    for (const [text, minor] of [
      ['Rs.0.10 debited at X', 10n],
      ['Rs.0.07 debited at X', 7n],
      ['Rs.1.15 debited at X', 115n],
      ['Rs.99,999.99 debited at X', 9999999n],
      ['Rs.1,00,00,000.01 debited at X', 1000000001n],
    ] as const) {
      expect(parseSms(text)?.amount.minor).toBe(minor);
    }
  });
});
