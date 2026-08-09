/**
 * What an expense is called when nobody described it.
 *
 * The app used to answer this at write time by storing the English word
 * "Expense" in the row, so a group's list read "Expense / Expense / Expense /
 * Expense" — four rows distinguishable only by their amounts. The word also
 * went into the append-only ledger, the CSV export and the text of anything the
 * server said about the expense afterwards, in one language, in an app that
 * speaks four.
 */

import { describe, expect, it } from 'vitest';

import { expenseTitle } from '../src/data/expenseTitle';

const t = {
  categories: { food: 'Food & drink', travel: 'Travel' },
  expense: { untitled: 'Untitled' },
};

const tamil = {
  categories: { food: 'உணவு & பானம்', travel: 'பயணம்' },
  expense: { untitled: 'பெயரிடப்படாதது' },
};

describe('expenseTitle', () => {
  it('uses what the person actually typed', () => {
    expect(expenseTitle('Beach shack dinner', 'food', t)).toBe('Beach shack dinner');
  });

  it('falls back to the category, which is true rather than invented', () => {
    expect(expenseTitle('', 'food', t)).toBe('Food & drink');
    expect(expenseTitle(null, 'travel', t)).toBe('Travel');
  });

  it('never says the English word "Expense"', () => {
    for (const title of [
      expenseTitle('', null, t),
      expenseTitle(null, null, t),
      expenseTitle(undefined, undefined, t),
      expenseTitle('   ', 'nonsense-category', t),
    ]) {
      expect(title).not.toBe('Expense');
    }
  });

  it('treats an empty string like no description, because the column is NOT NULL', () => {
    // This is the common case, not the exotic one: "no description" reaches the
    // screen as '' far more often than as null.
    expect(expenseTitle('', 'food', t)).toBe('Food & drink');
  });

  it('treats whitespace as nothing, because a keyboard leaves it behind', () => {
    expect(expenseTitle('   ', 'food', t)).toBe('Food & drink');
    expect(expenseTitle('\n\t ', null, t)).toBe('Untitled');
  });

  it('keeps meaningful text that merely has spaces around it', () => {
    expect(expenseTitle('  Chai  ', null, t)).toBe('Chai');
  });

  it('falls back to untitled when the category is unknown to the table', () => {
    // A category added by a newer build, read by an older one. Better a
    // translated "Untitled" than `undefined` rendered as a blank row.
    expect(expenseTitle(null, 'crypto-jet-fuel', t)).toBe('Untitled');
  });

  it('answers in the reader language, which a stored English word cannot', () => {
    expect(expenseTitle('', 'food', tamil)).toBe('உணவு & பானம்');
    expect(expenseTitle('', null, tamil)).toBe('பெயரிடப்படாதது');
  });
});
