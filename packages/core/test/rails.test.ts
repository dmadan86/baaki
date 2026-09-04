/**
 * Payment rails, per country.
 *
 * The settle screen used to be `'upi' | 'cash' | 'bank'` — three options, one
 * of which exists in one country. These tests pin the two things that make the
 * replacement worth having: a country gets its own rails first, and a rail
 * never claims a deep link it does not have.
 */

import { describe, expect, it } from 'vitest';

import { toMajorString } from '../src/money/money.js';
import {
  buildPaymentUri,
  defaultRailFor,
  isValidHandle,
  PAYMENT_RAILS,
  railById,
  railsFor,
} from '../src/settlement/rails';

const major = (amount: bigint, currency: string): string =>
  toMajorString({ minor: amount, currency });

describe('what a country can pay with', () => {
  it('leads with the rail that country actually uses', () => {
    expect(defaultRailFor('IN')).toBe('upi');
    expect(defaultRailFor('BR')).toBe('pix');
    expect(defaultRailFor('AE')).toBe('aani');
    expect(defaultRailFor('SG')).toBe('paynow');
    expect(defaultRailFor('TH')).toBe('promptpay');
    expect(defaultRailFor('ID')).toBe('qris');
  });

  it('does not offer one country’s rail to another', () => {
    const gulf = railsFor('AE').map((rail) => rail.id);
    expect(gulf).not.toContain('upi');
    expect(gulf).not.toContain('pix');

    const india = railsFor('IN').map((rail) => rail.id);
    expect(india).not.toContain('aani');
    expect(india).toContain('upi');
  });

  it('always ends with bank, cash and something else', () => {
    // Cash is never not an option, and a list that cannot express "I handed
    // them a note" is a list somebody has to lie to.
    for (const country of ['IN', 'AE', 'BR', 'US', 'ZZ', '']) {
      const ids = railsFor(country).map((rail) => rail.id);
      expect(ids.slice(-3), `for ${country || '(none)'}`).toEqual(['bank', 'cash', 'other']);
    }
  });

  it('gives an unknown or missing country a usable list rather than an empty one', () => {
    // Somebody who never set a country must still be able to record a debt.
    for (const country of [null, undefined, '', 'ZZ', '  ']) {
      const rails = railsFor(country);
      expect(rails.length).toBeGreaterThan(0);
      expect(rails.map((rail) => rail.id)).toContain('cash');
    }
    expect(defaultRailFor(null)).toBeTruthy();
  });

  it('offers the cross-border ones everywhere, because a trip is not one country', () => {
    for (const country of ['IN', 'AE', 'BR', 'DE']) {
      const ids = railsFor(country).map((rail) => rail.id);
      expect(ids).toContain('wise');
      expect(ids).toContain('revolut');
    }
  });

  it('reads a country case- and space-insensitively', () => {
    expect(defaultRailFor(' ae ')).toBe('aani');
    expect(defaultRailFor('ae')).toBe('aani');
  });
});

describe('a rail never claims a hand-off it does not have', () => {
  it('keeps custom schemes to the one that is published', () => {
    // An 'app' scheme is the dangerous kind: it fails silently when nothing is
    // installed to answer it. If this list ever grows, it grows because
    // somebody watched the link open a real bank app.
    const schemes = PAYMENT_RAILS.filter((rail) => rail.link === 'app').map((rail) => rail.id);
    expect(schemes).toEqual(['upi']);
  });

  it('allows an https link only where the URL is public and stable', () => {
    // These are a different risk: the worst case is a web page, not a tap that
    // appears to work while no money moves.
    const web = PAYMENT_RAILS.filter((rail) => rail.link === 'web').map((rail) => rail.id);
    expect(web).toEqual(['cashapp', 'paypal']);
  });

  it('returns null for every rail that cannot hand off', () => {
    for (const rail of PAYMENT_RAILS.filter((entry) => entry.link === null)) {
      const uri = buildPaymentUri(
        {
          railId: rail.id,
          handle: 'ravi@example.com',
          payeeName: 'Ravi',
          amount: 50000n,
          currency: 'AED',
        },
        major,
      );
      expect(uri, `${rail.id} must not invent a scheme`).toBeNull();
    }
  });

  it('builds the UPI intent it always built', () => {
    const uri = buildPaymentUri(
      {
        railId: 'upi',
        handle: 'ravi@okhdfcbank',
        payeeName: 'Ravi Kumar',
        amount: 45050n,
        currency: 'INR',
        note: 'Goa trip',
      },
      major,
    );
    expect(uri?.kind).toBe('app');
    expect(uri?.uri).toContain('upi://pay?');
    expect(uri?.uri).toContain('pa=ravi%40okhdfcbank');
    expect(uri?.uri).toContain('cu=INR');
    expect(uri?.uri).toContain('pn=Ravi+Kumar');
  });

  it('refuses to build a link from a handle that is not one', () => {
    expect(
      buildPaymentUri(
        { railId: 'upi', handle: 'not a upi id', payeeName: 'R', amount: 1n, currency: 'INR' },
        major,
      ),
    ).toBeNull();
  });

  it('says nothing at all about a rail it has never heard of', () => {
    expect(railById('bitcoin')).toBeNull();
    expect(isValidHandle('bitcoin', 'anything')).toBe(false);
  });
});

describe('handles', () => {
  it('accepts what each rail actually asks for', () => {
    expect(isValidHandle('upi', 'ravi@okhdfcbank')).toBe(true);
    expect(isValidHandle('aani', '+971 50 123 4567')).toBe(true);
    expect(isValidHandle('paynow', '+65 8123 4567')).toBe(true);
    expect(isValidHandle('venmo', '@ravi-kumar')).toBe(true);
    expect(isValidHandle('cashapp', '$ravi')).toBe(true);
    expect(isValidHandle('interac', 'ravi@example.com')).toBe(true);
    expect(isValidHandle('bank', 'AE07 0331 2345 6789 0123 456')).toBe(true);
  });

  it('takes a Pix key in any of its four shapes', () => {
    // The whole design of Pix is that the key is whatever the person
    // registered. A validator with an opinion here rejects real accounts.
    for (const key of [
      '12345678901',
      '+5511987654321',
      'ravi@example.com',
      '123e4567-e89b-12d3-a456-426614174000',
    ]) {
      expect(isValidHandle('pix', key), key).toBe(true);
    }
  });

  it('rejects an empty handle where one is needed, and asks for none where it is not', () => {
    expect(isValidHandle('upi', '   ')).toBe(false);
    expect(isValidHandle('aani', '')).toBe(false);
    expect(isValidHandle('cash', '')).toBe(true);
    expect(isValidHandle('other', '')).toBe(true);
  });

  it('does not take a UPI ID for a phone number', () => {
    expect(isValidHandle('upi', '+971501234567')).toBe(false);
    expect(isValidHandle('aani', 'ravi@okhdfcbank')).toBe(false);
  });
});

describe('the list itself', () => {
  it('has no duplicate ids', () => {
    const ids = PAYMENT_RAILS.map((rail) => rail.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('gives every rail that needs a handle something to say about it', () => {
    for (const rail of PAYMENT_RAILS) {
      if (rail.handle === 'none') continue;
      expect(rail.handleHint, `${rail.id} needs a hint`).not.toBe('');
    }
  });
});

describe('the markets Waves is going to next', () => {
  it('gives Australia its own instant rail', () => {
    // PayID settles over the NPP by mobile number or email. Without it an
    // Australian group fell straight through to bank and cash.
    expect(defaultRailFor('AU')).toBe('payid');
    expect(railsFor('AU').map((rail) => rail.id)).toContain('payid');
  });

  it('gives the United States and Canada theirs', () => {
    expect(
      railsFor('US')
        .map((rail) => rail.id)
        .slice(0, 3),
    ).toEqual(['zelle', 'venmo', 'cashapp']);
    expect(defaultRailFor('CA')).toBe('interac');
  });

  it('offers PayPal everywhere, because it is the one link that crosses', () => {
    // Somebody in Sydney paying somebody in Chennai has no shared rail. This
    // is the answer, and it is why PayPal is 'any' rather than a US entry.
    for (const country of ['US', 'CA', 'AU', 'IN', 'AE', 'BR']) {
      expect(
        railsFor(country).map((rail) => rail.id),
        country,
      ).toContain('paypal');
    }
  });

  it('builds a Cash App link that opens with the amount filled in', () => {
    const link = buildPaymentUri(
      { railId: 'cashapp', handle: 'ravi', payeeName: 'Ravi', amount: 2500n, currency: 'USD' },
      major,
    );
    expect(link?.kind).toBe('web');
    expect(link?.uri).toBe('https://cash.app/%24ravi/25.00');
  });

  it('accepts a $cashtag with or without its dollar', () => {
    for (const handle of ['ravi', '$ravi', '@ravi']) {
      const link = buildPaymentUri(
        { railId: 'cashapp', handle, payeeName: 'Ravi', amount: 2500n, currency: 'USD' },
        major,
      );
      expect(link?.uri, handle).toBe('https://cash.app/%24ravi/25.00');
    }
  });

  it('refuses a Cash App link in anything but dollars', () => {
    // A link carrying "25" for 25 Australian dollars would open a request for
    // 25 US dollars — worse than no link, because it looks right.
    const link = buildPaymentUri(
      { railId: 'cashapp', handle: '$ravi', payeeName: 'Ravi', amount: 2500n, currency: 'AUD' },
      major,
    );
    expect(link).toBeNull();
  });

  it('puts the currency in a PayPal link, so it is safe in any of them', () => {
    for (const [currency, expected] of [
      ['USD', 'https://paypal.me/ravi/25.00USD'],
      ['AUD', 'https://paypal.me/ravi/25.00AUD'],
      ['CAD', 'https://paypal.me/ravi/25.00CAD'],
    ] as const) {
      const link = buildPaymentUri(
        { railId: 'paypal', handle: '@ravi', payeeName: 'Ravi', amount: 2500n, currency },
        major,
      );
      expect(link?.uri, currency).toBe(expected);
    }
  });

  it('still refuses to invent a link for Zelle, Venmo, PayID or Interac', () => {
    // All three live inside somebody else's app and publish nothing stable.
    for (const railId of ['zelle', 'venmo', 'payid', 'interac']) {
      expect(
        buildPaymentUri(
          { railId, handle: '+61 400 123 456', payeeName: 'Ravi', amount: 2500n, currency: 'AUD' },
          major,
        ),
        railId,
      ).toBeNull();
    }
  });
});
