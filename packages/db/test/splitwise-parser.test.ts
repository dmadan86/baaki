import { describe, expect, it } from 'vitest';

import { parseSplitwiseCsv, SplitwiseProblemKind } from '../src/import/splitwise.js';

const newline = String.fromCharCode(10);

describe('Splitwise parser hardening', () => {
  it('accepts Splitwise headers with extra spaces, casing differences, and BOMs', () => {
    const parsed = parseSplitwiseCsv(
      [
        '\uFEFF Date , Description , Category , Cost , Currency , Asha , Ravi ',
        '2026-08-01,Dinner,Dining out,100.00,INR,50.00,-50.00',
      ].join(newline),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.people).toEqual(['Asha', 'Ravi']);
    expect(parsed.expenses).toHaveLength(1);
  });

  it('rejects duplicate person columns after trimming', () => {
    const parsed = parseSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha, Asha ',
        '2026-08-01,Dinner,Dining out,100.00,INR,50.00,-50.00',
      ].join(newline),
    );

    expect(parsed.errors).toMatchObject([{ kind: SplitwiseProblemKind.DuplicatePerson, row: 1 }]);
    expect(parsed.expenses).toEqual([]);
    expect(parsed.settlements).toEqual([]);
  });

  it('reports zero and negative costs instead of importing nonsensical rows', () => {
    const parsed = parseSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha,Ravi',
        '2026-08-01,Zero,Dining out,0.00,INR,0.00,0.00',
        '2026-08-02,Refund,Dining out,-100.00,INR,-50.00,50.00',
      ].join(newline),
    );

    expect(parsed.expenses).toEqual([]);
    expect(parsed.errors.map((error) => error.kind)).toEqual([
      SplitwiseProblemKind.NonPositiveCost,
      SplitwiseProblemKind.NonPositiveCost,
    ]);
  });

  it('rejects malformed person amounts instead of silently treating them as zero', () => {
    const parsed = parseSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha,Ravi',
        '2026-08-01,Dinner,Dining out,100.00,INR,not-a-number,-50.00',
      ].join(newline),
    );

    expect(parsed.expenses).toEqual([]);
    expect(parsed.errors).toMatchObject([{ kind: SplitwiseProblemKind.UnparseableRow, row: 2 }]);
  });

  it('parses non-INR currencies with their own minor-unit precision', () => {
    const parsed = parseSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha,Ravi',
        '2026-08-01,Sushi,Dining out,1234,JPY,617,-617',
      ].join(newline),
    );

    expect(parsed.errors).toEqual([]);
    expect(parsed.currency).toBe('JPY');
    expect(parsed.expenses).toMatchObject([
      {
        currency: 'JPY',
        amount: 1234n,
        payers: { Asha: 1234n },
        shares: { Asha: 617n, Ravi: 617n },
      },
    ]);
    expect(parsed.netByPerson).toEqual({ Asha: 617n, Ravi: -617n });
  });
});
