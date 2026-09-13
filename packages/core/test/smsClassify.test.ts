/**
 * The three piles, and the one that keeps the other two honest.
 *
 * Every case in the "other" block is a debit. Read as expenses — which is what
 * `proposeFromSms` does with them, correctly, because it is answering a
 * different question — they double-count a month: the card bill counts the
 * purchases a second time, the wallet top-up counts the wallet's own spends a
 * second time, the withdrawal counts the cash a person will enter by hand. The
 * screen shows them and does not add them up, and this is what makes that
 * possible.
 */

import { describe, expect, it } from 'vitest';

import { classifyOne, classifySms, SmsKind, SmsOtherReason, type SmsMessage } from '../src/sms';

const at = '2026-09-12T10:00:00.000Z';
const sms = (body: string, receivedAt = at, sender = 'AD-HDFCBK'): SmsMessage => ({
  body,
  receivedAt,
  sender,
});

const kindOfBody = (body: string): SmsKind | null => classifyOne(sms(body))?.kind ?? null;
const reasonOfBody = (body: string): SmsOtherReason | null =>
  classifyOne(sms(body))?.reason ?? null;

describe('money going out, to somebody, for something', () => {
  it('is an expense', () => {
    expect(kindOfBody('Rs.1,250.00 debited from a/c XX4471 on 12-09-26 at SWIGGY. Ref 4127')).toBe(
      SmsKind.Expense,
    );
    expect(
      kindOfBody('Sent Rs.245.00 From HDFC Bank A/C x1234 To SWIGGY On 12/09/26 Ref 5260'),
    ).toBe(SmsKind.Expense);
  });

  it('is still an expense when it is a mobile recharge', () => {
    // The wallet list deliberately does not contain bare "recharge": in Indian
    // English it means topping up a phone far more often than topping up a
    // wallet, and a phone recharge is a real thing somebody paid for.
    expect(
      kindOfBody('Rs.299 debited from A/c XX1234 for AIRTEL PREPAID RECHARGE on 12-09-26'),
    ).toBe(SmsKind.Expense);
  });
});

describe('money coming in', () => {
  it('is income', () => {
    expect(kindOfBody('INR 85,000.00 credited to A/c XX1234 on 01-09-26 by NEFT salary')).toBe(
      SmsKind.Income,
    );
  });
});

describe('money that moved and was neither spent nor earned', () => {
  it('calls a credit card bill what it is', () => {
    const body = 'Rs 9,165.71 debited from A/c XX1234 towards your Credit Card bill on 12-09-26';
    expect(kindOfBody(body)).toBe(SmsKind.Other);
    expect(reasonOfBody(body)).toBe(SmsOtherReason.CardBill);
  });

  it('calls a wallet top-up what it is', () => {
    const body = 'Rs 1,000 debited from A/c XX1234 for Wallet Recharge on 12-09-26';
    expect(kindOfBody(body)).toBe(SmsKind.Other);
    expect(reasonOfBody(body)).toBe(SmsOtherReason.WalletTopUp);
  });

  it('calls a fund purchase what it is', () => {
    const body = 'Rs 4,999.75 debited towards your SIP payment for ICICI Prudential on 08-09-26';
    expect(kindOfBody(body)).toBe(SmsKind.Other);
    expect(reasonOfBody(body)).toBe(SmsOtherReason.Investment);
  });

  it('calls cash out of a machine what it is', () => {
    const body = 'Rs.2000 debited by ATM cash withdrawal at SECTOR 5 on 12-09-26';
    expect(kindOfBody(body)).toBe(SmsKind.Other);
    expect(reasonOfBody(body)).toBe(SmsOtherReason.CashWithdrawal);
  });

  it('calls a refund what it is, though the money came in', () => {
    // Direction says credit; it is not income, it is an expense coming back.
    const body = 'Rs.599.00 refunded to your HDFC Card xx1234 by AMAZON on 12-09-26';
    expect(kindOfBody(body)).toBe(SmsKind.Other);
    expect(reasonOfBody(body)).toBe(SmsOtherReason.Refund);
  });

  it('prefers the more surprising label when a message earns two', () => {
    // Both patterns match. A refund of a card payment is more usefully labelled
    // a refund — a person checking the pile against their memory recognises the
    // reversal, not the fact that a card was involved.
    const body = 'Rs 500 reversed towards your credit card bill on 12-09-26';
    expect(reasonOfBody(body)).toBe(SmsOtherReason.Refund);
  });

  it('never preselects one, however clearly it was read', () => {
    const row = classifyOne(
      sms(
        'Rs 9,165.71 debited from A/c XX1234 towards your Credit Card bill on 12-09-26. Ref 998877',
      ),
    );
    expect(row?.confidence).toBeGreaterThanOrEqual(0.7);
    expect(row?.preselect).toBe(false);
  });
});

describe('the whole inbox at once', () => {
  const inbox = [
    sms('Rs.1,250.00 debited from a/c XX4471 on 12-09-26 at SWIGGY. UPI Ref: 412703998812'),
    sms('INR 85,000.00 credited to A/c XX1234 on 01-09-26 by NEFT'),
    sms('Rs 9,165.71 debited from A/c XX1234 towards your Credit Card bill on 10-09-26'),
    sms('Your OTP is 4471. Rs.1,250 will be debited.'),
    sms('Get a personal loan of up to Rs 5,00,000 at 10.5% p.a. Apply now!'),
  ];

  it('puts each message in exactly one pile', () => {
    const sorted = classifySms(inbox);
    expect(sorted.expenses).toHaveLength(1);
    expect(sorted.income).toHaveLength(1);
    expect(sorted.other).toHaveLength(1);
  });

  it('does not count an OTP or an advert as something it failed to read', () => {
    // The failure count is the signal that the parser has a gap. Counting the
    // two thirds of an inbox that were never about money would drown it.
    expect(classifySms(inbox).unreadable).toBe(0);
  });

  it('counts a message that plainly was about money and could not be read', () => {
    // It says "debited", it carries digits, and it is on none of the refusal
    // lists — so the parser should have got something out of it and did not.
    // That is a gap worth a line on the screen.
    const odd = [sms('Your a/c XX1234 has been debited. Please contact the branch.')];
    expect(classifySms(odd).unreadable).toBe(1);
  });

  it('does not count a balance report as a failure', () => {
    expect(
      classifySms([sms('Avl Bal in A/c XX1234 is Rs 12,340.00 as on 12-09-26.')]).unreadable,
    ).toBe(0);
  });

  it('collapses a message the bank sent twice', () => {
    const twice = [
      sms('Rs.1,250.00 debited from a/c XX4471 on 12-09-26 at SWIGGY. UPI Ref: 412703998812'),
      sms('Rs.1,250.00 debited from a/c XX4471 on 12-09-26 at SWIGGY. UPI Ref: 412703998812'),
    ];
    expect(classifySms(twice).expenses).toHaveLength(1);
  });

  it('leaves out what has already been dealt with', () => {
    const first = classifySms(inbox);
    const again = classifySms(inbox, {
      alreadySeen: new Set(first.expenses.map((row) => row.dedupeKey)),
    });
    expect(again.expenses).toHaveLength(0);
    // And only that pile: the others were not in the set.
    expect(again.income).toHaveLength(1);
  });

  it('hands each pile back newest first', () => {
    const spread = classifySms([
      sms('Rs.100 debited at A on 01-09-26. Ref 111111111111'),
      sms('Rs.200 debited at B on 09-09-26. Ref 222222222222'),
      sms('Rs.300 debited at C on 05-09-26. Ref 333333333333'),
    ]);
    expect(spread.expenses.map((row) => row.amount.minor)).toEqual([20000n, 30000n, 10000n]);
  });
});

describe('a stateful regex cannot make the piles wobble', () => {
  it('gives the same answer for the same message every time', () => {
    // Every pattern behind `otherReasonFor` is built without the `g` flag, so
    // `test` carries no `lastIndex` between calls. With it, every second call
    // on an identical message would come back false and half of a person's
    // credit card bills would be filed as expenses.
    const body = 'Rs 9,165.71 debited from A/c XX1234 towards your Credit Card bill on 12-09-26';
    for (let round = 0; round < 4; round += 1) {
      expect(reasonOfBody(body)).toBe(SmsOtherReason.CardBill);
    }
  });
});
