/**
 * Split parameters surviving JSON.
 *
 * The thing being pinned is that nothing changes value on the way. Everything
 * else in the ledger is downstream of these numbers: send an exact split whose
 * amounts came back one unit light and the shares no longer sum to the total,
 * which the write path rejects — or worse, they still sum and the wrong person
 * is short.
 *
 * The property is the test that matters: for any split parameters at all,
 * serialise → JSON → parse gives back exactly what went in.
 */

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  parseSplitParams,
  serialiseSplitParams,
  SplitWireError,
  type SplitParams,
} from '../src/index';

const memberId = fc.constantFrom('asha', 'ravi', 'priya', 'dev');
const minor = fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n });

const anySplitParams: fc.Arbitrary<SplitParams> = fc.oneof(
  fc.constant<SplitParams>({ kind: 'equal' }),
  fc
    .dictionary(memberId, minor, { minKeys: 1 })
    .map((amounts) => ({ kind: 'exact', amounts }) as SplitParams),
  fc
    .dictionary(memberId, fc.integer({ min: 0, max: 10000 }), { minKeys: 1 })
    .map((basisPoints) => ({ kind: 'percent', basisPoints }) as SplitParams),
  fc
    .dictionary(memberId, fc.integer({ min: 1, max: 100 }), { minKeys: 1 })
    .map((weights) => ({ kind: 'shares', weights }) as SplitParams),
  fc
    .dictionary(memberId, minor, { minKeys: 1 })
    .map((adjustments) => ({ kind: 'adjustment', adjustments }) as SplitParams),
  fc
    .record({
      items: fc.array(
        fc.record({ label: fc.string(), total: fc.bigInt({ min: 0n, max: 10n ** 12n }) }),
        { minLength: 1, maxLength: 6 },
      ),
      taxes: fc.option(fc.bigInt({ min: 0n, max: 10n ** 9n }), { nil: undefined }),
      tip: fc.option(fc.bigInt({ min: 0n, max: 10n ** 9n }), { nil: undefined }),
    })
    .map(
      ({ items, taxes, tip }) =>
        ({
          kind: 'itemized',
          items,
          claims: Object.fromEntries(items.map((_, index) => [index, ['asha']])),
          ...(taxes === undefined ? {} : { taxes }),
          ...(tip === undefined ? {} : { tip }),
        }) as SplitParams,
    ),
);

/** What actually happens to a payload: it goes through JSON, not just a function. */
const roundTrip = (params: SplitParams): SplitParams =>
  parseSplitParams(JSON.parse(JSON.stringify(serialiseSplitParams(params))));

describe('a round trip changes nothing', () => {
  it('holds for every kind of split', () => {
    fc.assert(
      fc.property(anySplitParams, (params) => {
        expect(roundTrip(params)).toEqual(params);
      }),
      { numRuns: 300 },
    );
  });

  it('holds for an amount far past what a double can hold', () => {
    // 2^53 is where a number silently stops counting. Minor units reach it:
    // this is ₹90,07,19,92,54,740.99 — absurd for a dinner, ordinary for a
    // property, and the whole reason these travel as strings.
    const params: SplitParams = {
      kind: 'exact',
      amounts: { asha: 9007199254740993n, ravi: 1n },
    };
    expect(roundTrip(params)).toEqual(params);
    expect((serialiseSplitParams(params).amounts as Record<string, string>).asha).toBe(
      '9007199254740993',
    );
  });
});

describe('serialising', () => {
  it('leaves the kinds that hold no money alone', () => {
    expect(serialiseSplitParams({ kind: 'equal' })).toEqual({ kind: 'equal' });
    expect(JSON.stringify(serialiseSplitParams({ kind: 'equal' }))).toBe('{"kind":"equal"}');
  });

  it('produces something JSON can actually take', () => {
    // The bug this whole module exists for: JSON.stringify throws on a bigint,
    // so an itemized bill could not be saved at all.
    const params: SplitParams = {
      kind: 'itemized',
      items: [{ label: 'Biryani', total: 45000n }],
      claims: { 0: ['asha'] },
      taxes: 2250n,
    };
    expect(() => JSON.stringify(params)).toThrow(TypeError);
    expect(() => JSON.stringify(serialiseSplitParams(params))).not.toThrow();
  });

  it('keeps an absent optional absent', () => {
    // `{ tip: null }` reads as "there was no tip"; leaving it out says the bill
    // had no tip line at all. They are not the same claim about the receipt.
    const wire = serialiseSplitParams({
      kind: 'itemized',
      items: [{ total: 100n }],
      claims: { 0: ['asha'] },
    });
    expect('tip' in wire).toBe(false);
    expect('taxes' in wire).toBe(false);
  });
});

describe('parsing what an older or stranger client sent', () => {
  it('takes a plain integer as well as a string', () => {
    // A number is accepted because it is unambiguous, not because it is wanted.
    expect(parseSplitParams({ kind: 'exact', amounts: { asha: 500 } })).toEqual({
      kind: 'exact',
      amounts: { asha: 500n },
    });
  });

  it('takes a bigint that never went through JSON', () => {
    expect(parseSplitParams({ kind: 'exact', amounts: { asha: 500n } })).toEqual({
      kind: 'exact',
      amounts: { asha: 500n },
    });
  });

  it('refuses a fractional minor unit instead of rounding it', () => {
    // Half a paisa means a float got into somebody's money upstream. Rounding
    // here would put a number in the ledger that nobody chose.
    expect(() => parseSplitParams({ kind: 'exact', amounts: { asha: 500.5 } })).toThrow(
      SplitWireError,
    );
  });

  it('refuses a number dressed as a string', () => {
    expect(() => parseSplitParams({ kind: 'exact', amounts: { asha: '5.00' } })).toThrow(
      /not a whole number/,
    );
  });

  it('refuses a kind it does not know', () => {
    expect(() => parseSplitParams({ kind: 'vibes' })).toThrow(/Unknown split kind: vibes/);
  });

  it('refuses something that is not an object at all', () => {
    expect(() => parseSplitParams(null)).toThrow(SplitWireError);
    expect(() => parseSplitParams('equal')).toThrow(SplitWireError);
  });

  it('refuses a shape that would otherwise parse to nothing', () => {
    expect(() => parseSplitParams({ kind: 'exact' })).toThrow(/amounts must be an object/);
    expect(() => parseSplitParams({ kind: 'itemized', items: {} })).toThrow(/list of items/);
  });

  it('keeps a negative adjustment negative', () => {
    // Adjustments go both ways: Ravi had the extra beer, Asha skipped dessert.
    expect(
      parseSplitParams({ kind: 'adjustment', adjustments: { ravi: '12000', asha: '-4000' } }),
    ).toEqual({ kind: 'adjustment', adjustments: { ravi: 12000n, asha: -4000n } });
  });
});
