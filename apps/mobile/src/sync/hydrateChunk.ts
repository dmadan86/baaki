/**
 * Chunked, yielding map — used to parse the mirror at cold start without freezing
 * the JS thread.
 *
 * Hydration reads every mirror row off disk and `JSON.parse`s it into memory
 * before `hydrated` flips and the first real frame can render. On a heavy
 * account that is O(all rows) of synchronous CPU in one burst: the loading
 * skeleton stops animating and the first interaction is held hostage until it
 * finishes — the single biggest device-perf risk in the app. Mapping the rows
 * through this instead breaks the work into chunks and yields to the event loop
 * between them, so React Native can paint and the skeleton keeps moving; the
 * total parse cost is the same, but it no longer monopolises the thread.
 */

/** Rows per chunk before yielding. Big enough that the yields are few, small
 *  enough that no single chunk blocks a frame. */
export const HYDRATE_CHUNK = 512;

/** A macrotask yield: `setTimeout(0)` lets RN commit a frame between chunks,
 *  which a microtask (`Promise.resolve()`) would not. */
export const yieldToEventLoop = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0);
  });

export async function mapYielding<T, U>(
  items: readonly T[],
  map: (item: T, index: number) => U,
  chunk: number = HYDRATE_CHUNK,
  onYield: () => Promise<void> = yieldToEventLoop,
): Promise<U[]> {
  // Guard the step: a zero, negative, fractional or non-finite `chunk` would
  // make the modulo below never (or nonsensically) fire — fall back to the
  // default rather than silently parsing the whole mirror in one burst again.
  const step = Number.isInteger(chunk) && chunk > 0 ? chunk : HYDRATE_CHUNK;
  const out: U[] = new Array<U>(items.length);
  for (let index = 0; index < items.length; index += 1) {
    out[index] = map(items[index] as T, index);
    // Yield after a full chunk, but never after the last item — the caller is
    // about to get the array, so a trailing yield is pure latency.
    if (index + 1 < items.length && (index + 1) % step === 0) await onYield();
  }
  return out;
}
