import { describe, expect, it } from 'vitest';

import { parseVoiceExpense, type VoiceGroupRef } from '@/lib/voiceExpense';

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
});
