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

import {
  SMS_LOW_CONFIDENCE,
  parseSms,
  proposeFromSms,
  senderHeader,
  type SmsMessage,
} from '../src/index.js';

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

  it('detects a lowercase currency word instead of defaulting to INR', () => {
    const parsed = parseSms('usd 42.50 spent on card XX1234 at STARBUCKS');
    expect(parsed?.amount.currency).toBe('USD');
    expect(parsed?.amount.minor).toBe(4250n);
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
    expect(proposed.map((c) => c.merchant)).toEqual([
      'AIRPORT CAFE',
      'GOA SHACK',
      'BEACH BAR',
      'HOME STORE',
    ]);
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

describe('a drafts list has no trip to bound by', () => {
  const old = sms('Rs.400 debited at CAFE on 05-01-24', '2024-01-05T09:00:00.000Z');
  const recent = sms('Rs.900 debited at SWIGGY on 02-03-26');

  it('proposes everything when no window is given at all', () => {
    // The paste flow has no trip: the person already chose which messages to
    // hand over, and a window would drop some of them invisibly.
    const proposed = proposeFromSms([old, recent]);
    expect(proposed.map((item) => item.amount.minor)).toEqual([40000n, 90000n]);
  });

  it('takes one bound on its own', () => {
    expect(proposeFromSms([old, recent], { from: '2026-01-01' })).toHaveLength(1);
    expect(proposeFromSms([old, recent], { to: '2025-01-01' })).toHaveLength(1);
  });

  it('treats an unparseable bound as no bound, rather than dropping everything', () => {
    // A half-typed date in a field must not silently empty the list.
    expect(proposeFromSms([old, recent], { from: '2026-0', to: '' })).toHaveLength(2);
  });

  it('still dedupes and still refuses credits with no window', () => {
    const proposed = proposeFromSms([
      recent,
      { ...recent },
      sms('Rs.2,000 credited to a/c XX4471 from RAVI on 02-03-26'),
    ]);
    expect(proposed).toHaveLength(1);
  });

  it('honours alreadyImported with no window', () => {
    const first = proposeFromSms([recent]);
    const key = first[0]!.dedupeKey;
    expect(proposeFromSms([recent], { alreadyImported: new Set([key]) })).toHaveLength(0);
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

/* ================================================================== *
 * The five messages the coverage study measured as failures.
 * ================================================================== */

describe('the formats that used to be dropped', () => {
  it('reads SBI, which quotes no currency at all', () => {
    // India's largest bank writes "debited by 150.0" with no Rs, no INR and no
    // symbol. Requiring a currency token lost every one of its UPI alerts.
    const parsed = parseSms(
      'Dear UPI user A/C X1234 debited by 150.0 on date 12Sep26 trf to SWIGGY Refno 526012345678',
      { region: 'IN' },
    );
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.amount.minor).toBe(15000n);
    expect(parsed?.amount.currency).toBe('INR');
    expect(parsed?.merchant).toBe('SWIGGY');
    expect(parsed?.occurredAt?.slice(0, 10)).toBe('2026-09-12');
  });

  it('reads ICICI, which names both sides of the transfer', () => {
    // "debited … ; SWIGGY credited" is one ordinary debit described from both
    // ends. Bailing whenever both words appear lost the whole format; the verb
    // nearest the amount is the one that means something.
    const parsed = parseSms(
      'ICICI Bank Acct XX123 debited for Rs 500.00 on 12-Sep-26; SWIGGY credited. UPI:526012345678',
      { region: 'IN' },
    );
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.amount.minor).toBe(50000n);
    expect(parsed?.merchant).toBe('SWIGGY');
  });

  it('does not read the word "credit" inside "Credit Card" as money coming in', () => {
    // The only failure in the set that wrote a wrong ledger entry: a ₹2,500
    // purchase booked as ₹2,500 received, looking entirely deliberate.
    const parsed = parseSms(
      'Your ICICI Bank Credit Card XX1234 has been used for a transaction of INR 2,500.00 on 12-Sep-26 at AMAZON.',
    );
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.amount.minor).toBe(250000n);
    expect(parsed?.merchant).toBe('AMAZON');
  });

  it('reads a refund, whichever way the bank conjugates it', () => {
    for (const text of [
      'Rs.599.00 refunded to your HDFC Card xx1234 by AMAZON on 12-09-26',
      'Rs.599.00 refund credited to your HDFC Card xx1234 on 12-09-26',
    ]) {
      expect(parseSms(text)?.direction).toBe('credit');
    }
  });

  it('reads a currency written after the number', () => {
    const parsed = parseSms('Your A/c XX1234 is debited with 350.00 INR on 12-09-26 at UBER.');
    expect(parsed?.amount.minor).toBe(35000n);
    expect(parsed?.amount.currency).toBe('INR');
    expect(parsed?.merchant).toBe('UBER');
  });
});

describe('who was actually paid', () => {
  it('reads a capitalised preposition', () => {
    // HDFC writes "To SWIGGY". A missing `i` flag meant it never matched.
    expect(
      parseSms('Sent Rs.245.00 From HDFC Bank A/C x1234 To SWIGGY On 12/09/26')?.merchant,
    ).toBe('SWIGGY');
  });

  it('reads a lowercase merchant', () => {
    expect(parseSms('rs.250 debited from a/c xx1234 at bigbasket on 12-09-26')?.merchant).toBe(
      'bigbasket',
    );
  });

  it('reads the handle out of a UPI address, not the word VPA', () => {
    const parsed = parseSms('Rs.75.00 debited from A/c XX1234 to VPA swiggy@icici on 12-09-26');
    expect(parsed?.merchant).toBe('swiggy');
  });

  it('never returns the "A" of "A/c" as a shop', () => {
    // A row reading "A" is worse than a row reading nothing: it looks parsed,
    // and somebody has to notice it is nonsense.
    const parsed = parseSms('INR 85,000.00 credited to A/c XX1234 on 01-09-26 by NEFT');
    expect(parsed?.merchant).toBeNull();
  });

  it('stops the name at the bank’s own words', () => {
    expect(parseSms('Paid Rs.120 to SWIGGY using Paytm UPI. Txn ID 526012345678')?.merchant).toBe(
      'SWIGGY',
    );
    expect(
      parseSms('Rp 150.000 didebet dari rekening 1234 di TOKOPEDIA pada 12/09/2026', {
        region: 'ID',
      })?.merchant,
    ).toBe('TOKOPEDIA');
  });

  it('does not score an implausible merchant, so it cannot be pre-selected on one', () => {
    // The old score counted fields found, so the VPA bug scored 1.0.
    const withName = parseSms('Rs.500 debited at CAFE on 02-03-26', { region: 'IN' });
    const withNonsense = parseSms('Rs.500 debited to A/c XX1234 on 02-03-26', { region: 'IN' });
    expect(withNonsense?.merchant).toBeNull();
    expect(withNonsense!.confidence).toBeLessThan(withName!.confidence);
  });
});

/* ================================================================== *
 * Hazard A — the decimal comma. A silent 1000x error.
 * ================================================================== */

describe('a comma can be the decimal point', () => {
  it('reads 1.234,56 as one thousand two hundred, not as one twenty-three', () => {
    // Half of Europe and most of Latin America write it this way. Read as an
    // English number it is €1.23 — a thousandfold error that looks valid.
    for (const region of ['DE', 'ES', 'BR', 'ID', 'TR', undefined]) {
      expect(parseSms('EUR 1.234,56 belastet Konto 3456', { region })?.amount.minor).toBe(123456n);
    }
  });

  it('reads 1,234.56 the English way in the same breath', () => {
    expect(parseSms('EUR 1,234.56 debited at IKEA', { region: 'IE' })?.amount.minor).toBe(123456n);
  });

  it('reads a lone dot with three digits after it as grouping, not as decimals', () => {
    // "EUR 1.234" cannot be €1.234: the euro has two minor digits. The
    // currency's own exponent settles this without needing a locale at all.
    expect(parseSms('EUR 1.234 belastet Konto 3456', { region: 'DE' })?.amount.minor).toBe(123400n);
    expect(parseSms('EUR 1.234 belastet Konto 3456')?.amount.minor).toBe(123400n);
    expect(parseSms('EUR 1.234 belastet Konto 3456')?.inferred).not.toContain('decimalSeparator');
  });

  it('reads a space or a non-breaking space as grouping', () => {
    const nbsp = String.fromCharCode(0x00a0);
    expect(
      parseSms('Votre compte 1234 a ete debite de 1 234,56 EUR le 12/09/2026', { region: 'FR' })
        ?.amount.minor,
    ).toBe(123456n);
    expect(
      parseSms(`Votre compte 1234 a ete debite de 1${nbsp}234,56 EUR le 12/09/2026`, {
        region: 'FR',
      })?.amount.minor,
    ).toBe(123456n);
  });

  it('reads the Swiss apostrophe as grouping', () => {
    expect(
      parseSms("CHF 1'234.50 belastet Konto 4471 bei MIGROS", { region: 'CH' })?.amount.minor,
    ).toBe(123450n);
  });

  it('reads Arabic’s own separators', () => {
    // U+066B is the decimal separator and U+066C the thousands separator — the
    // mirror image of the Latin habit.
    const decimal = String.fromCharCode(0x066b);
    expect(
      parseSms(`AED 250${decimal}50 debited from Card 4471`, { region: 'AE' })?.amount.minor,
    ).toBe(25050n);
  });

  it('still reads India’s two-digit grouping', () => {
    expect(parseSms('Rs 1,23,456.78 debited at HOTEL TAJ')?.amount.minor).toBe(12345678n);
  });
});

/* ================================================================== *
 * Hazard B — the currency's exponent.
 * ================================================================== */

describe('a currency decides how many decimals it has', () => {
  it('keeps all three digits of a Kuwaiti dinar', () => {
    // KWD, BHD, OMR, JOD and TND have three minor digits. Capping the fraction
    // at two silently turned 12.345 into 12.340.
    const parsed = parseSms('KWD 12.345 debited from Account XX1234 at LULU', { region: 'KW' });
    expect(parsed?.amount.minor).toBe(12345n);
    expect(parsed?.inferred).not.toContain('decimalSeparator');
  });

  it('says so when three decimals could equally have been grouping', () => {
    // With no locale, "KWD 12.345" is genuinely either twelve dinars and a bit
    // or twelve thousand. It is answered, and it says it guessed.
    const parsed = parseSms('KWD 12.345 debited from Account XX1234 at LULU');
    expect(parsed?.amount.minor).toBe(12345n);
    expect(parsed?.inferred).toContain('decimalSeparator');
    expect(parsed!.confidence).toBeLessThan(
      parseSms('KWD 12.345 debited from Account XX1234 at LULU', { region: 'KW' })!.confidence,
    );
  });

  it('never gives a zero-decimal currency phantom minor units', () => {
    expect(parseSms('JPY 1,234 spent on card 1234 at LAWSON')?.amount.minor).toBe(1234n);
    expect(parseSms('JPY 1,234.00 spent on card 1234 at LAWSON')?.amount.minor).toBe(1234n);
    expect(parseSms('KRW 50,000 spent at OLIVE YOUNG')?.amount.minor).toBe(50000n);
  });
});

/* ================================================================== *
 * Hazard C — day-first or month-first.
 * ================================================================== */

describe('08/05/2026 is two different days', () => {
  const body = 'USD 42.50 spent on card ending 1234 at TARGET on 08/05/2026';

  it('is the 5th of August in the United States', () => {
    expect(parseSms(body, { region: 'US' })?.occurredAt?.slice(0, 10)).toBe('2026-08-05');
  });

  it('is the 8th of May in India', () => {
    expect(parseSms(body, { region: 'IN' })?.occurredAt?.slice(0, 10)).toBe('2026-05-08');
  });

  it('falls back to day-first when nobody said, and says that it did', () => {
    const parsed = parseSms(body);
    expect(parsed?.occurredAt?.slice(0, 10)).toBe('2026-05-08');
    expect(parsed?.inferred).toContain('dateOrder');
    expect(parsed!.confidence).toBeLessThan(parseSms(body, { region: 'IN' })!.confidence);
  });

  it('does not guess when a component is over twelve', () => {
    const parsed = parseSms('Rs.400 debited at CAFE on 28/02/26');
    expect(parsed?.occurredAt?.slice(0, 10)).toBe('2026-02-28');
    expect(parsed?.inferred).not.toContain('dateOrder');
  });

  it('takes an explicit order over the region', () => {
    expect(parseSms(body, { region: 'IN', dateOrder: 'mdy' })?.occurredAt?.slice(0, 10)).toBe(
      '2026-08-05',
    );
  });

  it('reads an ISO date, which used to match nothing at all', () => {
    expect(parseSms('EUR 20.00 debited from account 1234 at IKEA on 2026-09-12')?.occurredAt).toBe(
      '2026-09-12T00:00:00.000Z',
    );
    expect(
      parseSms("You've spent Rs.1500.00 via Debit Card xx1234 at AMAZON on 2026-09-12:14:23:05.")
        ?.occurredAt,
    ).toBe('2026-09-12T14:23:05.000Z');
  });

  it('reads a month name in either order', () => {
    expect(parseSms('USD 42.50 spent at STARBUCKS on Sep 12, 2026')?.occurredAt?.slice(0, 10)).toBe(
      '2026-09-12',
    );
    expect(parseSms('USD 42.50 spent at STARBUCKS on 12-Sep-2026')?.occurredAt?.slice(0, 10)).toBe(
      '2026-09-12',
    );
    expect(parseSms('Rs 500 debited at CAFE on date 12Sep26')?.occurredAt?.slice(0, 10)).toBe(
      '2026-09-12',
    );
  });

  it('reads a month name in another language', () => {
    for (const [text, day] of [
      ['EUR 20,00 belastet Konto 1234 bei IKEA am 12. Okt 2026', '2026-10-12'],
      ['EUR 20,00 debitado da conta 1234 em 12 de dezembro de 2026', '2026-12-12'],
      ['EUR 20,00 debite du compte 1234 le 12 juillet 2026', '2026-07-12'],
      ['EUR 20,00 debite du compte 1234 le 12 juin 2026', '2026-06-12'],
      ['TRY 20,00 harcama 12 Agustos 2026 kart 1234', '2026-08-12'],
    ] as const) {
      expect(parseSms(text, { region: 'DE' })?.occurredAt?.slice(0, 10)).toBe(day);
    }
  });
});

/* ================================================================== *
 * Hazard D — the language the bank is writing in.
 * ================================================================== */

describe('banks do not all write in English', () => {
  it('reads a debit in the languages Waves ships in and the ones it banks in', () => {
    for (const [text, context] of [
      ['Ihr Konto DE12 wurde mit EUR 1.234,56 belastet am 12.09.2026 bei REWE.', { region: 'DE' }],
      ['Compra de EUR 45,90 en MERCADONA con tarjeta 1234 el 12/09/2026', { region: 'ES' }],
      ['Compra aprovada: R$ 1.234,56 em MERCADO LIVRE em 12/09/2026', { region: 'BR' }],
      ['Votre compte 1234 a ete debite de 45,00 EUR le 12/09/2026 chez FNAC', { region: 'FR' }],
      ['Rp 150.000 didebet dari rekening 1234 di TOKOPEDIA pada 12/09/2026', { region: 'ID' }],
      ['Hesabinizdan 250,75 TL harcama yapildi. Kart 1234, 12.09.2026', { region: 'TR' }],
      ['Akaun 1234 didebit RM 125.50 di MYDIN pada 12/09/2026', { region: 'MY' }],
      ['Tai khoan 1234 ghi no 1.250.000 VND tai HIGHLANDS ngay 12/09/2026', { region: 'VN' }],
      ['Kortkop 1 234,50 kr hos ICA 12/09/2026 kort 1234', { region: 'SE' }],
    ] as const) {
      expect(parseSms(text, context), text).not.toBeNull();
      expect(parseSms(text, context)?.direction, text).toBe('debit');
    }
  });

  it('reads Thai, which separates nothing with spaces', () => {
    const parsed = parseSms('บัญชี 1234 ถูกหัก THB 1,250.00 ที่ 7-ELEVEN 12/09/2026', {
      region: 'TH',
    });
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.amount.minor).toBe(125000n);
    expect(parsed?.merchant).toBe('7-ELEVEN');
  });

  it('refuses the same six kinds of message in those languages too', () => {
    // A false accept is worse than a false reject, and internationalising the
    // debit verbs without internationalising these would internationalise the
    // parser's worst false positive rather than its usefulness.
    for (const [text, context] of [
      [
        'Su codigo de verificacion es 445566 para una compra de EUR 250,00 en ZARA.',
        { region: 'ES' },
      ],
      ['Ihr Konto wird mit EUR 49,90 belastet am 15.09.2026 fuer NETFLIX.', { region: 'DE' }],
      ['Votre transaction de 45,00 EUR chez FNAC a ete refusee.', { region: 'FR' }],
      ['Saldo rekening 1234 adalah Rp 1.250.000 pada 12/09/2026.', { region: 'ID' }],
      ['Kredi karti 1234 son odeme tarihi 18.09.2026, tutar 1.250,00 TL.', { region: 'TR' }],
      ['Sua compra de R$ 250,00 foi recusada por saldo insuficiente.', { region: 'BR' }],
    ] as const) {
      expect(parseSms(text, context), text).toBeNull();
    }
  });
});

describe('right-to-left text', () => {
  const isolateStart = String.fromCharCode(0x2066);
  const isolateEnd = String.fromCharCode(0x2069);

  it('reads an Arabic debit', () => {
    const parsed = parseSms('تم خصم 250.50 د.إ من البطاقة 4471 لدى كارفور 12-09-2026', {
      region: 'AE',
    });
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.amount.currency).toBe('AED');
    expect(parsed?.amount.minor).toBe(25050n);
    expect(parsed?.accountTail).toBe('4471');
  });

  it('is not defeated by an invisible bidi isolate around the amount', () => {
    // An Arabic alert wraps its amount so the digits render left-to-right
    // inside a right-to-left sentence. The marks are invisible; a parser that
    // does not strip them simply fails to see a number that is plainly there.
    const wrapped = `تم خصم ${isolateStart}AED 250.50${isolateEnd} من الحساب 4471`;
    expect(parseSms(wrapped, { region: 'AE' })?.amount.minor).toBe(25050n);
  });

  it('refuses an Arabic one-time password', () => {
    expect(parseSms('رمز التحقق 445566 لعملية شراء بقيمة 250.00 د.إ', { region: 'AE' })).toBeNull();
  });
});

/* ================================================================== *
 * Hazard E — numerals that are not 0-9.
 * ================================================================== */

describe('numerals that are not ASCII', () => {
  it('reads Devanagari digits', () => {
    const parsed = parseSms('आपके खाते XX1234 से ५००.०० रुपये डेबिट किए गए 12-09-2026', {
      region: 'IN',
    });
    expect(parsed?.direction).toBe('debit');
    expect(parsed?.amount.currency).toBe('INR');
    expect(parsed?.amount.minor).toBe(50000n);
  });

  it('reads Arabic-Indic digits', () => {
    const parsed = parseSms('تم خصم ٢٥٠.٥٠ د.إ من البطاقة ٤٤٧١', { region: 'AE' });
    expect(parsed?.amount.minor).toBe(25050n);
    expect(parsed?.accountTail).toBe('4471');
  });
});

/* ================================================================== *
 * Hazard F — currency coverage, and the symbols that are shared.
 * ================================================================== */

describe('a symbol is not a currency', () => {
  const body = '$42.50 spent on card ending 1234 at STARBUCKS on 12-09-2026';

  it('reads the dollar of the country it was told about', () => {
    expect(parseSms(body, { region: 'CA' })?.amount.currency).toBe('CAD');
    expect(parseSms(body, { region: 'AU' })?.amount.currency).toBe('AUD');
    expect(parseSms(body, { region: 'SG' })?.amount.currency).toBe('SGD');
    expect(parseSms(body, { region: 'CA' })?.inferred).not.toContain('currency');
  });

  it('falls back to the dollar most people mean, and says it guessed', () => {
    const parsed = parseSms(body);
    expect(parsed?.amount.currency).toBe('USD');
    expect(parsed?.inferred).toContain('currency');
  });

  it('reads a qualified symbol without needing a region at all', () => {
    expect(parseSms('R$ 1.234,56 debitado do cartao 1234')?.amount.currency).toBe('BRL');
    expect(parseSms('S$ 42.50 spent on card 1234 at NTUC')?.amount.currency).toBe('SGD');
  });

  it('reads the Nordic krone by country', () => {
    expect(
      parseSms('Kortkop 1 234,50 kr hos ICA kort 1234', { region: 'SE' })?.amount.currency,
    ).toBe('SEK');
    expect(
      parseSms('Kortkop 1 234,50 kr hos REMA kort 1234', { region: 'NO' })?.amount.currency,
    ).toBe('NOK');
  });

  it('reads both the symbol and the code for the currencies Waves supports', () => {
    for (const [text, code] of [
      ['₹ 500 debited at CAFE', 'INR'],
      ['INR 500 debited at CAFE', 'INR'],
      ['€ 20,00 belastet bei IKEA', 'EUR'],
      ['£ 20.00 debited at TESCO', 'GBP'],
      ['AED 89.00 debited at CARREFOUR', 'AED'],
      ['MYR 125.50 debited at MYDIN', 'MYR'],
      ['RM 125.50 didebit di MYDIN', 'MYR'],
      ['Rp 150.000 didebet di TOKOPEDIA', 'IDR'],
      ['THB 1,250.00 debited at 7-ELEVEN', 'THB'],
      ['฿ 1,250.00 debited at 7-ELEVEN', 'THB'],
      ['VND 1.250.000 debited at HIGHLANDS', 'VND'],
      ['ZAR 250.00 debited at WOOLWORTHS', 'ZAR'],
      ['CHF 20.00 belastet bei MIGROS', 'CHF'],
      ['TRY 250,75 harcama MIGROS', 'TRY'],
      ['LKR 500 debited at KEELLS', 'LKR'],
    ] as const) {
      expect(parseSms(text, { region: undefined })?.amount.currency, text).toBe(code);
    }
  });

  it('takes a caller’s default when the message names nothing', () => {
    const parsed = parseSms('Account XX1234 debited by 150.0 at CAFE on 12-09-2026', {
      defaultCurrency: 'GBP',
    });
    expect(parsed?.amount.currency).toBe('GBP');
    expect(parsed?.amount.minor).toBe(15000n);
    expect(parsed?.inferred).not.toContain('currency');
  });

  it('takes the region’s currency before falling back to rupees', () => {
    expect(
      parseSms('Account XX1234 debited by 150.0 at CAFE', { region: 'DE' })?.amount.currency,
    ).toBe('EUR');
    const nothing = parseSms('Account XX1234 debited by 150.0 at CAFE');
    expect(nothing?.amount.currency).toBe('INR');
    expect(nothing?.inferred).toContain('currency');
  });
});

/* ================================================================== *
 * Hazard G — the sender.
 * ================================================================== */

describe('the sender is a hint, never a filter', () => {
  it('strips the operator prefix, which differs by carrier and circle', () => {
    expect(senderHeader('AD-HDFCBK')).toBe('HDFCBK');
    expect(senderHeader('VM-HDFCBK')).toBe('HDFCBK');
    expect(senderHeader('JD-HDFCBK-S')).toBe('HDFCBK');
    // Nothing here assumes the Indian shape: a bare short code is itself.
    expect(senderHeader('SANTANDER')).toBe('SANTANDER');
    expect(senderHeader('')).toBeNull();
  });

  it('raises confidence when the sender looks like a bank', () => {
    const body = 'Rs.500 debited at CAFE on 02-03-26';
    const known = parseSms(body, { region: 'IN', sender: 'AD-HDFCBK' });
    const unknown = parseSms(body, { region: 'IN', sender: '+919876543210' });
    expect(known!.confidence).toBeGreaterThan(unknown!.confidence);
  });

  it('never drops a message because the sender is not recognised', () => {
    // A bank the list has not heard of is still a bank, and a person who pasted
    // a message has already decided it is worth reading.
    for (const sender of ['ZZ-NEVERHEARDOF', '+441234567890', undefined]) {
      expect(parseSms('EUR 20.00 debited at IKEA on 12-09-2026', { sender })).not.toBeNull();
    }
  });
});

/* ================================================================== *
 * Two amounts, and which one is the transaction.
 * ================================================================== */

describe('a message that quotes a balance as well', () => {
  it('takes the transaction even when the balance comes first', () => {
    // The old parser took the first number and was right by luck, because
    // Indian banks quote the transaction first.
    const parsed = parseSms(
      'Avl Bal Rs 9,999.00. Rs.450.00 debited from A/c XX1234 at DOMINOS on 12-09-26',
      { region: 'IN' },
    );
    expect(parsed?.amount.minor).toBe(45000n);
    expect(parsed?.merchant).toBe('DOMINOS');
  });

  it('still takes the transaction when the balance trails', () => {
    expect(
      parseSms('Rs.450.00 debited from A/c XX1234 at DOMINOS on 12-09-26. Avl Bal: Rs.9,999.00')
        ?.amount.minor,
    ).toBe(45000n);
  });
});

/* ================================================================== *
 * The rule the whole file is written around.
 * ================================================================== */

describe('never guess silently', () => {
  it('reports nothing as inferred when every signal was present', () => {
    const parsed = parseSms(
      'INR 1,234.00 debited from A/c no. XX3456 on 2026-09-12 at AMAZON. Ref: 412703998812',
      { region: 'IN' },
    );
    expect(parsed?.inferred).toEqual([]);
    expect(parsed?.confidence).toBeGreaterThanOrEqual(SMS_LOW_CONFIDENCE);
  });

  it('names each field it had to decide for itself', () => {
    const parsed = parseSms('$ 1.234 debited at CAFE on 08/05/26');
    expect(parsed?.inferred).toContain('currency');
    expect(parsed?.inferred).toContain('dateOrder');
  });

  it('lowers confidence far enough that a guessed row is not pre-selected', () => {
    const proposed = proposeFromSms([
      { body: 'KWD 12.345 debited on 08/05/26', receivedAt: '2026-05-08T10:00:00.000Z' },
    ]);
    expect(proposed[0]?.preselect).toBe(false);
    expect(proposed[0]?.inferred).toContain('decimalSeparator');
  });

  it('passes the caller’s context to every message, and the sender on top', () => {
    const proposed = proposeFromSms(
      [
        {
          body: '$42.50 spent on card ending 1234 at TARGET on 08/05/2026',
          receivedAt: '2026-08-05T10:00:00.000Z',
          sender: 'CHASE',
        },
      ],
      { context: { region: 'US' } },
    );
    expect(proposed[0]?.amount.currency).toBe('USD');
    expect(proposed[0]?.at.slice(0, 10)).toBe('2026-08-05');
    expect(proposed[0]?.inferred).toEqual([]);
    expect(proposed[0]?.preselect).toBe(true);
  });

  it('refuses a pathological body rather than thinking about it', () => {
    expect(parseSms(`Rs ${'1'.repeat(5000)} debited at CAFE`)).not.toBeUndefined();
  });
});

describe('the payee is inside the reference, not in the sentence', () => {
  // India's banks do not name the shop in the prose. They write the sentence
  // around the account number and put the counterparty in a slash-separated
  // reference, so a parser reading only the prose finds "A/c no. XX9811",
  // rejects it, and returns nothing — correctly, and uselessly. Every UPI
  // payment on the phone then read "No shop named", which is most of them.

  it('reads a person out of an Axis UPI debit', () => {
    const parsed = parseSms(
      'INR 2000.00 debited from A/c no. XX9811 on 13-09-26 11:04:18 IST. Info- UPI/P2A/526012345678/RAHUL SHARMA. Avl Bal- INR 15000.00.',
    );
    expect(parsed?.merchant).toBe('RAHUL SHARMA');
    expect(parsed?.amount?.minor).toBe(200000n);
  });

  it('reads a shop out of a P2M reference', () => {
    const parsed = parseSms(
      'Amt Debited INR 125.00 A/c XX9811 13-09-26. Info- UPI/P2M/987654321/ZOMATO LTD. Avl Bal INR 900.00',
    );
    expect(parsed?.merchant).toBe('ZOMATO LTD');
  });

  it('keeps the whole name, not its first word', () => {
    // The character class has to admit a space or "RAHUL SHARMA" arrives as
    // "RAHUL", which looks like a reading rather than a truncation.
    const parsed = parseSms(
      'Debit INR 105.00 A/c no XX897 13-09-26 UPI/P2M/123456789/CONSTRUCTION HOUSE',
    );
    expect(parsed?.merchant).toBe('CONSTRUCTION HOUSE');
  });

  it('never mistakes a segment code for the payee', () => {
    // P2M, P2A and CR sit exactly where a name could. Taking the first lettered
    // segment would file every payment under "P2M".
    const parsed = parseSms('INR 300.00 debited A/c XX1111 13-09-26 UPI/P2M/555555555/BLUE TOKAI');
    expect(parsed?.merchant).toBe('BLUE TOKAI');
  });

  it('takes the handle out of a VPA, never the bank behind it', () => {
    const parsed = parseSms('INR 80.00 debited A/c XX2222 13-09-26 UPI/P2M/444444/swiggy@okicici');
    expect(parsed?.merchant).toBe('swiggy');
  });

  it('stops at the end of the reference, not the end of the message', () => {
    // Admitting spaces means the match can run on into the bank's next
    // sentence; a full stop and a space end it.
    const parsed = parseSms(
      'INR 50.00 debited A/c XX3333 13-09-26 UPI/P2A/111111/ASHA K. Avl Bal- INR 2000.00 Call 18004195959',
    );
    expect(parsed?.merchant).toBe('ASHA K');
  });
});

describe('the bank telling you how to complain is not a shop', () => {
  it('does not file a payment under "dispute"', () => {
    // Reported from a device: a real ₹400 debit filed under the shop name
    // "dispute", at full confidence. "To dispute, call 1800..." ends nearly
    // every Indian debit alert, and "to" is a merchant preposition — so the
    // sentence written to protect somebody became the name of what they bought.
    // Worse than no name at all: nothing about it looks wrong.
    const parsed = parseSms(
      'INR 400.00 debited from your A/c XX4006 on 13-09-26. To dispute, call 18001030 or SMS BLOCK to 919951860002',
    );
    expect(parsed?.merchant).toBeNull();
    // The money is still read. Only the name was ever wrong.
    expect(parsed?.amount?.minor).toBe(40000n);
  });

  it('does not file one under "report" or "block" either', () => {
    const parsed = parseSms(
      'INR 900.00 debited A/c XX5555 on 13-09-26. To report fraud, SMS BLOCK to 9999999999',
    );
    expect(parsed?.merchant).toBeNull();
  });
});

describe('a card spend names the shop by where it stands', () => {
  it('reads the shop between the time and the limit', () => {
    // "Spent Card no. XX1234 INR 225 13-09-26 12:30:00 SWIGGY Avl Lmt INR 50000"
    // has no preposition anywhere near the name. What it has is position.
    const parsed = parseSms(
      'Spent Card no. XX1234 INR 225 13-09-26 12:30:00 SWIGGY Avl Lmt INR 50000',
    );
    expect(parsed?.merchant).toBe('SWIGGY');
    expect(parsed?.amount?.minor).toBe(22500n);
  });

  it('does not read the balance line as the shop', () => {
    const parsed = parseSms('Spent Card no. XX1234 INR 225 13-09-26 12:30:00 Avl Lmt INR 50000');
    expect(parsed?.merchant).toBeNull();
  });
});
