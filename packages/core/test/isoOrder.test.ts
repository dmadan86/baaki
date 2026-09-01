/**
 * The comparator every feed in the app now sorts by.
 *
 * It replaced `localeCompare`, which was doing locale-aware collation on UTC
 * timestamps. The risk in that swap is not speed, it is *order*: if plain
 * comparison ever disagreed with the collator on a real stamp, a feed would
 * quietly reshuffle. So the properties below check the new comparator against
 * actual chronology (`Date.parse`), not against the thing it replaced.
 */

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { byNewest, byOldest, compareStamps } from '../src/time/iso.js';

/** ISO instants the way Postgres hands them back: UTC, fixed width. */
const instants = (): fc.Arbitrary<string> =>
  fc
    .integer({ min: 0, max: 4_000_000_000 })
    .map((seconds) => new Date(seconds * 1000).toISOString());

/** Plain dates, the other stamp shape the ledger stores. */
const dates = (): fc.Arbitrary<string> => instants().map((iso) => iso.slice(0, 10));

describe('compareStamps', () => {
  it('agrees with real chronology on every ISO instant', () => {
    fc.assert(
      fc.property(instants(), instants(), (a, b) => {
        const bySign = Math.sign(compareStamps(a, b));
        const byClock = Math.sign(Date.parse(a) - Date.parse(b));
        expect(bySign).toBe(byClock);
      }),
    );
  });

  it('agrees with real chronology on plain dates too', () => {
    fc.assert(
      fc.property(dates(), dates(), (a, b) => {
        expect(Math.sign(compareStamps(a, b))).toBe(Math.sign(Date.parse(a) - Date.parse(b)));
      }),
    );
  });

  it('matches what localeCompare used to answer', () => {
    // The swap must be invisible in the output, only in the cost.
    fc.assert(
      fc.property(instants(), instants(), (a, b) => {
        expect(Math.sign(compareStamps(a, b))).toBe(Math.sign(a.localeCompare(b)));
      }),
    );
  });

  it('puts a missing stamp last, whichever way it is read', () => {
    const rows = [
      { at: '2026-01-02T00:00:00.000Z' },
      { at: null },
      { at: '2026-03-04T00:00:00.000Z' },
    ];
    expect([...rows].sort(byNewest((r) => r.at)).map((r) => r.at)).toEqual([
      '2026-03-04T00:00:00.000Z',
      '2026-01-02T00:00:00.000Z',
      null,
    ]);
    expect([...rows].sort(byOldest((r) => r.at)).map((r) => r.at)).toEqual([
      '2026-01-02T00:00:00.000Z',
      '2026-03-04T00:00:00.000Z',
      null,
    ]);
  });

  it('treats an empty string as missing, not as the beginning of time', () => {
    expect(compareStamps('', '2026-01-01T00:00:00.000Z')).toBe(1);
    expect(compareStamps('2026-01-01T00:00:00.000Z', '')).toBe(-1);
    expect(compareStamps('', '')).toBe(0);
    expect(compareStamps(undefined, null)).toBe(0);
  });
});

describe('byNewest / byOldest', () => {
  it('are exact reverses of each other on distinct stamps', () => {
    fc.assert(
      fc.property(fc.uniqueArray(instants(), { minLength: 1, maxLength: 30 }), (stamps) => {
        const rows = stamps.map((at) => ({ at }));
        const newest = [...rows].sort(byNewest((r) => r.at)).map((r) => r.at);
        const oldest = [...rows].sort(byOldest((r) => r.at)).map((r) => r.at);
        expect(newest).toEqual([...oldest].reverse());
      }),
    );
  });

  it('actually orders newest first', () => {
    fc.assert(
      fc.property(fc.array(instants(), { maxLength: 30 }), (stamps) => {
        const sorted = stamps.map((at) => ({ at })).sort(byNewest((r) => r.at));
        for (let i = 1; i < sorted.length; i += 1) {
          expect(Date.parse(sorted[i - 1]!.at) >= Date.parse(sorted[i]!.at)).toBe(true);
        }
      }),
    );
  });
});
