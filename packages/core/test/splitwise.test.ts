/**
 * "Splitwise CSV round-trips into correct balances" (TDR §10, M3).
 *
 * The word carrying the weight is *balances*. A Splitwise export gives each
 * person's net per row, not what they paid and what they owed separately, so an
 * exact reconstruction of the original expense is not available from the file.
 * What must be exact — and what these tests pin — is that every imported
 * expense's payers and shares both sum to the cost, and that the resulting
 * balances match the file to the paisa.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import {
  ImportProblemKind,
  importSplitwiseCsv,
  parseCsvAmount,
  parseCsvRow,
} from '../src/index.js';

const HEADER = 'Date,Description,Category,Cost,Currency,Asha,Bharath,Chitra';

const file = (...rows: string[]): string => [HEADER, ...rows].join('\n');

describe('reading the file', () => {
  it('imports a straightforward export', () => {
    const result = importSplitwiseCsv(
      file(
        '2026-03-01,Dinner,Food and drink,1200.00,INR,800.00,-400.00,-400.00',
        '2026-03-02,Taxi,Transportation,600.00,INR,-200.00,400.00,-200.00',
        'Total balance,,,0.00,INR,600.00,0.00,-600.00',
      ),
    );

    expect(result.problems).toHaveLength(0);
    expect(result.people).toEqual(['Asha', 'Bharath', 'Chitra']);
    expect(result.expenses).toHaveLength(2);
    expect(result.currency).toBe('INR');
  });

  it('never imports the Total balance row, which would double everything', () => {
    const result = importSplitwiseCsv(
      file(
        '2026-03-01,Dinner,Food and drink,1200.00,INR,800.00,-400.00,-400.00',
        'Total balance,,,0.00,INR,800.00,-400.00,-400.00',
      ),
    );
    expect(result.expenses).toHaveLength(1);
    expect(result.balances.Asha).toBe(80000n);
  });

  it('handles a description containing a comma', () => {
    const result = importSplitwiseCsv(
      file('2026-03-01,"Dinner, drinks and a taxi",Food,900.00,INR,600.00,-300.00,-300.00'),
    );
    expect(result.expenses[0]?.description).toBe('Dinner, drinks and a taxi');
    expect(result.expenses[0]?.amount).toBe(90000n);
  });

  it('handles an escaped quote inside a description', () => {
    const result = importSplitwiseCsv(
      file('2026-03-01,"Ravi""s birthday",Food,300.00,INR,200.00,-100.00,-100.00'),
    );
    expect(result.expenses[0]?.description).toBe('Ravi"s birthday');
  });

  it('keeps the category when there is one', () => {
    const result = importSplitwiseCsv(
      file('2026-03-01,Dinner,Food and drink,300.00,INR,200.00,-100.00,-100.00'),
    );
    expect(result.expenses[0]?.category).toBe('Food and drink');
  });

  it('accepts Splitwise headers with extra spaces, casing differences, and BOMs', () => {
    const result = importSplitwiseCsv(
      [
        '\uFEFF Date , Description , Category , Cost , Currency , Asha , Bharath ',
        '2026-03-01,Dinner,Food and drink,300.00,INR,200.00,-200.00',
      ].join('\n'),
    );

    expect(result.problems).toEqual([]);
    expect(result.people).toEqual(['Asha', 'Bharath']);
    expect(result.expenses).toHaveLength(1);
  });

  it('rejects duplicate person columns after trimming', () => {
    const result = importSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha, Asha ',
        '2026-03-01,Dinner,Food and drink,300.00,INR,200.00,-100.00',
      ].join('\n'),
    );

    expect(result.problems).toMatchObject([{ kind: ImportProblemKind.DuplicatePerson, row: 1 }]);
    expect(result.expenses).toEqual([]);
  });

  it('rejects zero, negative, and malformed person amounts', () => {
    const result = importSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha,Bharath',
        '2026-03-01,Zero,Food,0.00,INR,0.00,0.00',
        '2026-03-02,Refund,Food,-300.00,INR,-200.00,100.00',
        '2026-03-03,Broken,Food,300.00,INR,not-a-number,-100.00',
      ].join('\n'),
    );

    expect(result.expenses).toEqual([]);
    expect(result.problems.map((problem) => problem.kind)).toEqual([
      ImportProblemKind.NonPositiveCost,
      ImportProblemKind.NonPositiveCost,
      ImportProblemKind.UnparseableRow,
    ]);
  });

  it('parses non-INR currencies with their own minor-unit precision', () => {
    const result = importSplitwiseCsv(
      [
        'Date,Description,Category,Cost,Currency,Asha,Bharath',
        '2026-03-01,Sushi,Food,1234,JPY,617,-617',
      ].join('\n'),
    );

    expect(result.problems).toEqual([]);
    expect(result.currency).toBe('JPY');
    expect(result.expenses).toMatchObject([
      {
        currency: 'JPY',
        amount: 1234n,
        payers: { Asha: 1234n },
        shares: { Asha: 617n, Bharath: 617n },
      },
    ]);
    expect(result.balances).toEqual({ Asha: 617n, Bharath: -617n });
  });
});

describe('money is parsed by digits, never as a float (ADR-003)', () => {
  it('reads amounts a float would round wrong', () => {
    for (const [text, minor] of [
      ['0.10', 10n],
      ['0.07', 7n],
      ['1.15', 115n],
      ['-1.15', -115n],
      ['1,23,456.78', 12345678n],
      ['99999.99', 9999999n],
    ] as const) {
      expect(parseCsvAmount(text, 'INR')).toBe(minor);
    }
  });

  it('tells a blank column apart from a zero', () => {
    // They mean the same thing here, but a parser that cannot distinguish them
    // also cannot tell a malformed cell from an empty one.
    expect(parseCsvAmount('', 'INR')).toBeNull();
    expect(parseCsvAmount('0.00', 'INR')).toBe(0n);
    expect(parseCsvAmount('not a number', 'INR')).toBeNull();
  });

  it('respects a currency with no minor unit', () => {
    expect(parseCsvAmount('1000', 'JPY')).toBe(1000n);
    expect(parseCsvAmount('1000', 'INR')).toBe(100000n);
  });
});

describe('what the import guarantees', () => {
  const result = importSplitwiseCsv(
    file(
      '2026-03-01,Dinner,Food and drink,1200.00,INR,800.00,-400.00,-400.00',
      '2026-03-02,Taxi,Transportation,600.00,INR,-200.00,400.00,-200.00',
      '2026-03-03,Hotel,Home,1000.00,INR,-333.34,-333.33,666.67',
    ),
  );

  it('every expense has payers summing to its cost', () => {
    for (const expense of result.expenses) {
      const paid = Object.values(expense.payers).reduce((sum, value) => sum + value, 0n);
      expect(paid).toBe(expense.amount);
    }
  });

  it('every expense has shares summing to its cost', () => {
    for (const expense of result.expenses) {
      const owed = Object.values(expense.shares).reduce((sum, value) => sum + value, 0n);
      expect(owed).toBe(expense.amount);
    }
  });

  it('no share is negative — nobody is owed money by an expense', () => {
    for (const expense of result.expenses) {
      for (const share of Object.values(expense.shares)) {
        expect(share).toBeGreaterThanOrEqual(0n);
      }
    }
  });

  it('reproduces the file balances exactly', () => {
    // 800 - 200 - 333.34 = 266.66
    expect(result.balances.Asha).toBe(26666n);
    // -400 + 400 - 333.33 = -333.33
    expect(result.balances.Bharath).toBe(-33333n);
    // -400 - 200 + 666.67 = 66.67
    expect(result.balances.Chitra).toBe(6667n);
  });

  it('and those balances sum to zero (ADR-004)', () => {
    const total = Object.values(result.balances).reduce((sum, value) => sum + value, 0n);
    expect(total).toBe(0n);
  });

  it('hands the write path split params it can use unchanged', () => {
    const expense = result.expenses[0];
    expect(expense?.splitParams.kind).toBe('exact');
    expect(expense?.splitParams.amounts).toEqual(expense?.shares);
  });

  it('imports the same file identically every time', () => {
    const again = importSplitwiseCsv(
      file(
        '2026-03-01,Dinner,Food and drink,1200.00,INR,800.00,-400.00,-400.00',
        '2026-03-02,Taxi,Transportation,600.00,INR,-200.00,400.00,-200.00',
        '2026-03-03,Hotel,Home,1000.00,INR,-333.34,-333.33,666.67',
      ),
    );
    expect(again).toEqual(result);
  });
});

describe('rows that must not be imported quietly', () => {
  it('skips a row whose columns do not add up, and says which', () => {
    // The one case where importing would silently corrupt balances. It is named
    // and skipped rather than adjusted into shape.
    const result = importSplitwiseCsv(
      file(
        '2026-03-01,Dinner,Food,1200.00,INR,800.00,-400.00,-400.00',
        '2026-03-02,Broken,Food,600.00,INR,500.00,-100.00,-100.00',
      ),
    );
    expect(result.expenses).toHaveLength(1);
    expect(result.problems[0]?.kind).toBe('row_does_not_balance');
    expect(result.problems[0]?.row).toBe(3);
    expect(result.problems[0]?.message).toContain('Broken');
  });

  it('imports the good rows even when some are bad', () => {
    // Refusing forty good rows because three are malformed is the wrong trade
    // for somebody moving years of history.
    const result = importSplitwiseCsv(
      file(
        '2026-03-01,One,Food,300.00,INR,200.00,-100.00,-100.00',
        'not-a-date,Two,Food,300.00,INR,200.00,-100.00,-100.00',
        '2026-03-03,Three,Food,300.00,INR,200.00,-100.00,-100.00',
      ),
    );
    expect(result.expenses.map((e) => e.description)).toEqual(['One', 'Three']);
    expect(result.problems[0]?.kind).toBe('unparseable_row');
  });

  it('refuses a file that is not a Splitwise export', () => {
    const result = importSplitwiseCsv('Name,Email\nAsha,asha@example.com');
    expect(result.expenses).toHaveLength(0);
    expect(result.problems[0]?.kind).toBe('no_people');
  });

  it('says so when the file has a header and nothing else', () => {
    const result = importSplitwiseCsv(HEADER);
    expect(result.problems[0]?.kind).toBe('no_rows');
  });

  it('names a bad currency rather than guessing', () => {
    const result = importSplitwiseCsv(
      file('2026-03-01,Dinner,Food,300.00,RUPEES,200.00,-100.00,-100.00'),
    );
    expect(result.problems[0]?.kind).toBe('unknown_currency');
  });
});

describe('the property that actually matters', () => {
  it('balances always match the file, for any set of rows that balance', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.tuple(
            fc.bigInt({ min: 1n, max: 10n ** 7n }),
            fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }),
            fc.bigInt({ min: -(10n ** 6n), max: 10n ** 6n }),
          ),
          { minLength: 1, maxLength: 25 },
        ),
        (rows) => {
          const expected = [0n, 0n, 0n];
          const lines = rows.map(([cost, a, b], index) => {
            // Chitra absorbs whatever is left, so every row balances by
            // construction — which is what a real export guarantees.
            const c = -(a + b);
            expected[0] = (expected[0] as bigint) + a;
            expected[1] = (expected[1] as bigint) + b;
            expected[2] = (expected[2] as bigint) + c;
            return `2026-03-${String((index % 28) + 1).padStart(2, '0')},Row ${index},Food,${decimal(
              cost,
            )},INR,${decimal(a)},${decimal(b)},${decimal(c)}`;
          });

          const result = importSplitwiseCsv(file(...lines));
          expect(result.problems).toHaveLength(0);
          expect(result.balances.Asha).toBe(expected[0]);
          expect(result.balances.Bharath).toBe(expected[1]);
          expect(result.balances.Chitra).toBe(expected[2]);

          // And the invariant every expense must satisfy to be writable at all.
          for (const expense of result.expenses) {
            const paid = Object.values(expense.payers).reduce((sum, value) => sum + value, 0n);
            const owed = Object.values(expense.shares).reduce((sum, value) => sum + value, 0n);
            expect(paid).toBe(expense.amount);
            expect(owed).toBe(expense.amount);
          }
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('parseCsvRow', () => {
  it('splits plainly when there are no quotes', () => {
    expect(parseCsvRow('a,b,c')).toEqual(['a', 'b', 'c']);
  });

  it('keeps an empty trailing field', () => {
    expect(parseCsvRow('a,b,')).toEqual(['a', 'b', '']);
  });
});

/** Minor units back to the decimal a CSV would carry. */
function decimal(minor: bigint): string {
  const negative = minor < 0n;
  const absolute = negative ? -minor : minor;
  const whole = absolute / 100n;
  const fraction = (absolute % 100n).toString().padStart(2, '0');
  return `${negative ? '-' : ''}${whole}.${fraction}`;
}
