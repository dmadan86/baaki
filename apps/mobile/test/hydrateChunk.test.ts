import { describe, expect, it, vi } from 'vitest';

import { mapYielding } from '../src/sync/hydrateChunk';

describe('mapYielding', () => {
  it('maps every item in order, like a plain map', async () => {
    const out = await mapYielding(
      [1, 2, 3, 4, 5],
      (n, i) => `${i}:${n * 2}`,
      2,
      async () => {},
    );
    expect(out).toEqual(['0:2', '1:4', '2:6', '3:8', '4:10']);
  });

  it('yields once per completed chunk, but never after the last item', async () => {
    const onYield = vi.fn(async () => {});
    // 5 items, chunk 2 → yields after index 1 and index 3 (multiples of 2 that
    // are not the final item). Index 4 is last, so no trailing yield.
    await mapYielding([1, 2, 3, 4, 5], (n) => n, 2, onYield);
    expect(onYield).toHaveBeenCalledTimes(2);
  });

  it('does not yield when a whole chunk boundary is the final item', async () => {
    const onYield = vi.fn(async () => {});
    // 4 items, chunk 2 → boundary at index 1 (yield) and index 3 (last, no yield).
    await mapYielding([1, 2, 3, 4], (n) => n, 2, onYield);
    expect(onYield).toHaveBeenCalledTimes(1);
  });

  it('never yields when the chunk is at least the length', async () => {
    const onYield = vi.fn(async () => {});
    const out = await mapYielding([1, 2, 3], (n) => n, 512, onYield);
    expect(out).toEqual([1, 2, 3]);
    expect(onYield).not.toHaveBeenCalled();
  });

  it('falls back to the default step for a non-positive-integer chunk', async () => {
    const onYield = vi.fn(async () => {});
    // chunk 0 would make the modulo NaN and never yield; the guard falls back to
    // the 512 default, so a short list still maps correctly and simply doesn't
    // reach a chunk boundary.
    for (const bad of [0, -4, 2.5, Number.NaN]) {
      onYield.mockClear();
      const out = await mapYielding([1, 2, 3], (n) => n, bad, onYield);
      expect(out).toEqual([1, 2, 3]);
      expect(onYield).not.toHaveBeenCalled();
    }
  });

  it('handles an empty list without mapping or yielding', async () => {
    const map = vi.fn((n: number) => n);
    const onYield = vi.fn(async () => {});
    const out = await mapYielding([], map, 2, onYield);
    expect(out).toEqual([]);
    expect(map).not.toHaveBeenCalled();
    expect(onYield).not.toHaveBeenCalled();
  });
});
