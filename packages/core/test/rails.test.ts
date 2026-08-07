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
  it('marks only UPI as deep-linkable', () => {
    // Guessing at a scheme produces a button that silently fails on somebody's
    // phone while they believe they have paid. If this list ever grows, it
    // grows because somebody watched the link open a real bank app.
    const linkable = PAYMENT_RAILS.filter((rail) => rail.deepLink).map((rail) => rail.id);
    expect(linkable).toEqual(['upi']);
  });

  it('returns null for every rail that cannot hand off', () => {
    for (const rail of PAYMENT_RAILS.filter((entry) => !entry.deepLink)) {
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
    expect(uri).toContain('upi://pay?');
    expect(uri).toContain('pa=ravi%40okhdfcbank');
    expect(uri).toContain('cu=INR');
    expect(uri).toContain('pn=Ravi+Kumar');
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
