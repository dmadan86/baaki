/**
 * Merchant categorisation pins: the brand table covers travel brands the base
 * catalog does not, gateway noise and store numbers are stripped, it falls back
 * to guessCategory for everything the catalog already knew, and an unrecognised
 * string yields null (not "Other").
 */

import { describe, expect, it } from 'vitest';

import { CategoryId } from '../src/category/categories';
import {
  categoriseMerchant,
  normaliseMerchantName,
  merchantTokens,
} from '../src/category/merchant';

describe('normaliseMerchantName', () => {
  it('strips gateway noise and pure-digit runs', () => {
    expect(normaliseMerchantName('POS UPI SWIGGY*ORDER 8842')).toBe('swiggy order');
    expect(normaliseMerchantName('IB/NEFT/AGODA COM PTE LTD')).toBe('agoda pte');
  });

  it('drops store numbers but keeps alphanumeric names', () => {
    expect(merchantTokens('MARRIOTT 007 GOA')).toEqual(['marriott', 'goa']);
  });
});

describe('categoriseMerchant', () => {
  it('recognises travel brands the base catalog does not carry', () => {
    expect(categoriseMerchant('EMIRATES AIRLINE')).toBe(CategoryId.Travel);
    expect(categoriseMerchant('MAKEMYTRIP')).toBe(CategoryId.Travel);
    expect(categoriseMerchant('POS AGODA.COM')).toBe(CategoryId.Stay);
    expect(categoriseMerchant('Marriott Hotels')).toBe(CategoryId.Stay);
  });

  it('falls back to the keyword catalog for things it already knew', () => {
    expect(categoriseMerchant('SWIGGY BANGALORE')).toBe(CategoryId.Food);
    expect(categoriseMerchant('UPI-UBER INDIA')).toBe(CategoryId.Travel);
  });

  it('returns null for the unrecognised, never Other', () => {
    expect(categoriseMerchant('ZZQ HOLDINGS 4471')).toBeNull();
    expect(categoriseMerchant('')).toBeNull();
    expect(categoriseMerchant(null)).toBeNull();
    expect(categoriseMerchant('   ')).toBeNull();
  });

  it('is deterministic and case-insensitive', () => {
    expect(categoriseMerchant('emirates')).toBe(categoriseMerchant('EMIRATES'));
  });

  it('does not read a brand out of a substring', () => {
    // "air" inside "airtel" must not be an airline; airtel is a bill (Home).
    expect(categoriseMerchant('AIRTEL POSTPAID')).toBe(CategoryId.Home);
  });
});
