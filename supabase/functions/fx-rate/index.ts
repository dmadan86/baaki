/**
 * fx-rate — today's mid-market rate, as an exact rational (ADR-003).
 *
 * Two things this deliberately is not:
 *
 * It is not the only way to get a rate into an expense. Typing one, or deriving
 * it from a card statement, works offline and is often *more* accurate — a bank
 * charges its own rate with its own markup, and a mid-market number will never
 * match anybody's statement. This endpoint is the convenience, not the truth.
 *
 * It is not a float. The upstream publishes decimals; we turn them into num/den
 * at the boundary and never let a double past it, because the rate stored on an
 * expense has to reproduce the same minor units a year from now.
 *
 * Rates come from the ECB via Frankfurter, which needs no key and publishes
 * daily reference rates. It is behind auth anyway so this cannot be used as an
 * open currency proxy on somebody else's bill.
 */

import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
} from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';

/** ECB publishes once a working day, so a short cache is free accuracy-wise. */
const CACHE_TTL_MS = 60 * 60 * 1000;
const cache = new Map<string, { at: number; body: unknown }>();

/**
 * "91.2534" becomes 912534/10000 — exactly, with no intermediate double.
 * The upstream sends JSON numbers, so the value is re-serialised rather than
 * read as a float: `String(91.2534)` is lossless for anything ECB publishes,
 * and parsing the digits is what keeps the rational exact.
 */
function toRational(value: number): { num: string; den: string } {
  const text = String(value);
  if (!/^\d+(\.\d+)?$/.test(text)) {
    throw new HttpError(502, 'BAD_RATE', `Upstream sent "${text}", which is not a rate`);
  }
  const [whole = '0', fraction = ''] = text.split('.');
  return {
    num: BigInt(whole + fraction).toString(),
    den: (10n ** BigInt(fraction.length)).toString(),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    const url = new URL(request.url);
    const from = (url.searchParams.get('from') ?? '').toUpperCase();
    const to = (url.searchParams.get('to') ?? '').toUpperCase();

    if (!/^[A-Z]{3}$/.test(from) || !/^[A-Z]{3}$/.test(to)) {
      throw new HttpError(400, 'BAD_CURRENCY', 'Pass two ISO-4217 codes, e.g. ?from=EUR&to=INR');
    }
    if (from === to) {
      throw new HttpError(400, 'SAME_CURRENCY', 'Those are the same currency');
    }

    // Signed in, so this is not an open proxy. No membership check: a rate is
    // not group data, and asking for one reveals nothing about any ledger.
    const caller = asCaller(request);
    const { data: user } = await caller.auth.getUser();
    if (!user?.user) throw new HttpError(401, 'UNAUTHENTICATED', 'Sign in first');

    const key = `${from}:${to}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
      // Deliberately before the limiter. A cache hit costs nothing and reaches
      // no upstream, and counting it would spend somebody's allowance on the
      // one path this function is proud of.
      return json(hit.body);
    }

    // Only the calls that leave the building. The cache is per-isolate, so a
    // cold isolate misses and this is what stops a script turning every miss
    // into an upstream request.
    await enforceRateLimit(asService(), request, 'fx-rate', user.user.id);

    const response = await fetch(
      `https://api.frankfurter.dev/v1/latest?base=${from}&symbols=${to}`,
    );
    if (!response.ok) {
      throw new HttpError(
        502,
        'RATE_UNAVAILABLE',
        'Could not reach the exchange just now — you can type the rate instead',
      );
    }

    const payload = (await response.json()) as { date?: string; rates?: Record<string, number> };
    const value = payload.rates?.[to];
    if (typeof value !== 'number') {
      throw new HttpError(
        404,
        'RATE_UNAVAILABLE',
        `No published rate for ${from} to ${to} — you can type one instead`,
      );
    }

    const { num, den } = toRational(value);
    const body = {
      // Exactly the shape stored in `expense_versions.fx`, so the client can
      // hand it straight back on the write with nothing in between to get wrong.
      num,
      den,
      from,
      to,
      // The rate's own date, not now(): ECB reference rates are for a day, and
      // saying otherwise would misreport when the number was true.
      ts: payload.date ? `${payload.date}T00:00:00.000Z` : new Date().toISOString(),
      source: 'ecb',
    };

    cache.set(key, { at: Date.now(), body });
    return json(body);
  } catch (error) {
    return errorResponse(error, { fn: 'fx-rate' });
  }
});
