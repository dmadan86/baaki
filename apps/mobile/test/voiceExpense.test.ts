import { describe, expect, it } from 'vitest';

import { matchMemberNames, parseVoiceExpense, type VoiceGroupRef } from '@/lib/voiceExpense';

const groups: VoiceGroupRef[] = [
  { id: 'g-goa', name: 'Goa Trip' },
  { id: 'g-flat', name: 'Flat 4B' },
  { id: 'g-unnamed', name: null },
];

describe('parseVoiceExpense', () => {
  it('pulls the amount and converts to minor units', () => {
    const parsed = parseVoiceExpense('add 500 rupees to the Goa trip', groups);
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.amountMinor).toBe(50000n);
    expect(parsed.currency).toBe('INR');
  });

  it('matches the group the sentence names', () => {
    expect(parseVoiceExpense('add 500 to Goa trip', groups).groupId).toBe('g-goa');
    expect(parseVoiceExpense('200 for flat', groups).groupId).toBe('g-flat');
  });

  it('leaves the group null when nothing is named', () => {
    expect(parseVoiceExpense('add 500 rupees', groups).groupId).toBeNull();
  });

  it('leaves the group null when the name is ambiguous', () => {
    const twoTrips: VoiceGroupRef[] = [
      { id: 'a', name: 'Goa Trip' },
      { id: 'b', name: 'Manali Trip' },
    ];
    // Only "trip" is shared, and both score on it — a tie is treated as no match.
    expect(parseVoiceExpense('add 500 for the trip', twoTrips).groupId).toBeNull();
  });

  it('keeps the description and drops amount, currency, group and filler', () => {
    const parsed = parseVoiceExpense('add 1200 rupees for dinner on the Goa trip', groups);
    expect(parsed.note).toBe('dinner');
    expect(parsed.amountMinor).toBe(120000n);
    expect(parsed.groupId).toBe('g-goa');
  });

  it('handles thousands separators and decimals', () => {
    const parsed = parseVoiceExpense('spent 1,299.50 dollars', groups);
    expect(parsed.amountMajor).toBe(1299.5);
    expect(parsed.amountMinor).toBe(129950n);
    expect(parsed.currency).toBe('USD');
  });

  it('returns nulls for a sentence with no number', () => {
    const parsed = parseVoiceExpense('groceries for the flat', groups);
    expect(parsed.amountMinor).toBeNull();
    expect(parsed.amountMajor).toBeNull();
    expect(parsed.groupId).toBe('g-flat');
    expect(parsed.note).toBe('groceries');
  });

  it('reads a currency symbol', () => {
    expect(parseVoiceExpense('₹750 taxi', groups).currency).toBe('INR');
    expect(parseVoiceExpense('$40 lunch', groups).currency).toBe('USD');
  });

  it('reads a split count without mistaking it for the amount', () => {
    const parsed = parseVoiceExpense('split 500 rupees among 3 people for dinner', groups);
    expect(parsed.amountMajor).toBe(500);
    expect(parsed.splitCount).toBe(3);
    expect(parsed.note).toBe('dinner');
  });

  it('takes the amount from the currency, even when the count comes first', () => {
    const parsed = parseVoiceExpense('split among 4 people, 800 rupees dinner', groups);
    expect(parsed.amountMajor).toBe(800);
    expect(parsed.splitCount).toBe(4);
  });

  it('reads "N ways" as the count', () => {
    expect(parseVoiceExpense('300 split 3 ways', groups).splitCount).toBe(3);
    expect(parseVoiceExpense('300 split 3 ways', groups).amountMajor).toBe(300);
  });

  it('leaves the count null when no split is said', () => {
    expect(parseVoiceExpense('add 500 for dinner', groups).splitCount).toBeNull();
  });
});

describe('matchMemberNames', () => {
  const members = [
    { id: 'm-me', name: 'You' },
    { id: 'm-ravi', name: 'Ravi' },
    { id: 'm-priya', name: 'Priya Nair' },
    { id: 'm-sam', name: 'Sam' },
  ];

  it('picks the members the sentence names', () => {
    expect(matchMemberNames('split dinner with Ravi and Priya', members)).toEqual([
      'm-ravi',
      'm-priya',
    ]);
  });

  it('matches on any word of a full name', () => {
    expect(matchMemberNames('300 for Nair', members)).toEqual(['m-priya']);
  });

  it('returns nothing when no one is named', () => {
    expect(matchMemberNames('add 500 for dinner', members)).toEqual([]);
  });
});

import { detectCreateGroup, normalizeDigits, parseVoiceExpenses } from '@/lib/voiceExpense';

describe('parseVoiceExpenses (several in one breath)', () => {
  it('splits a comma-and-and list into one expense each', () => {
    const result = parseVoiceExpenses(
      '5 rupees for snacks, 10 rupee for tea, shopping 1000, others 100',
      groups,
    );
    expect(result.items.map((item) => item.amountMajor)).toEqual([5, 10, 1000, 100]);
    expect(result.items.map((item) => item.note)).toEqual(['snacks', 'tea', 'shopping', 'others']);
  });

  it('carries a currency named once to the later items that name none', () => {
    const result = parseVoiceExpenses('5 rupees snacks, 10 tea, 20 cab', groups);
    expect(result.items.every((item) => item.currency === 'INR')).toBe(true);
  });

  it('keeps a lone expense working, with its named group', () => {
    const result = parseVoiceExpenses('add 500 rupees for dinner on the Goa trip', groups);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(500);
    expect(result.items[0].note).toBe('dinner');
    expect(result.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
  });

  it('reads a create-group instruction and still files the expenses', () => {
    const result = parseVoiceExpenses('make a group called Weekend and add 200 for lunch', groups);
    expect(result.group).toEqual({ kind: 'create', name: 'Weekend' });
    expect(result.items).toHaveLength(1);
    expect(result.items[0].amountMajor).toBe(200);
    expect(result.items[0].note).toBe('lunch');
  });

  it('drops segments that carry no amount', () => {
    const result = parseVoiceExpenses('hello, 50 for coffee, um', groups);
    expect(result.items.map((item) => item.amountMajor)).toEqual([50]);
  });
});

describe('detectCreateGroup', () => {
  it('lifts the name and returns the rest', () => {
    expect(detectCreateGroup('create a group named Goa Trip and add 100')).toEqual({
      name: 'Goa Trip',
      rest: 'add 100',
    });
  });

  it('is null when no group is asked for', () => {
    expect(detectCreateGroup('add 100 for lunch')).toBeNull();
  });
});

describe('normalizeDigits', () => {
  it('turns Devanagari, Tamil and Arabic-Indic numerals into ASCII', () => {
    expect(normalizeDigits('५००')).toBe('500');
    expect(normalizeDigits('௫')).toBe('5');
    expect(normalizeDigits('٢٠')).toBe('20');
  });

  it('reads an amount written in native numerals', () => {
    const result = parseVoiceExpenses('५०० rupees for dinner', groups);
    expect(result.items[0]?.amountMajor).toBe(500);
  });
});
