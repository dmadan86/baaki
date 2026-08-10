/**
 * The Android inbox reader.
 *
 * It is one native call wrapped in a lot of refusals, and the refusals are the
 * point: on the wrong platform, in a build without the module, with the
 * permission denied or blocked, or when the read itself errors, it must come
 * back with a described result the screen can turn into a sentence — never an
 * exception, because an exception here is a crash at the exact moment somebody
 * tapped a button asking for their bank messages.
 *
 * Every side effect is injected, so the whole matrix runs without a device.
 */

import { describe, expect, it, vi } from 'vitest';

import { proposeFromSms } from '@baaki/core';

import {
  buildSmsFilter,
  mapSmsRow,
  parseSmsList,
  readSmsInbox,
  type NativeSmsModule,
  type SmsReaderDeps,
  type SmsWindow,
} from '@/lib/smsReader';

const WINDOW: SmsWindow = { from: '2026-07-01', to: '2026-07-08' };

/** A native module whose `list` replies with a canned success payload. */
function moduleReturning(rows: unknown): NativeSmsModule {
  return {
    list: (_filter, _fail, success) =>
      success(Array.isArray(rows) ? rows.length : 0, JSON.stringify(rows)),
  };
}

function deps(over: Partial<SmsReaderDeps> = {}): SmsReaderDeps {
  return {
    platformOS: 'android',
    loadModule: () => moduleReturning([]),
    requestPermission: async () => 'granted',
    ...over,
  };
}

// ─────────────────────────────────────────────────── the pure pieces ──

describe('buildSmsFilter', () => {
  it('asks the inbox for the window, widened a day each side', () => {
    const filter = JSON.parse(buildSmsFilter(WINDOW));
    expect(filter.box).toBe('inbox');
    expect(filter.maxCount).toBe(500);
    // 2026-07-01T00:00Z minus a day, 2026-07-08T23:59:59.999Z plus a day.
    expect(filter.minDate).toBe(Date.parse('2026-06-30T00:00:00.000Z'));
    expect(filter.maxDate).toBe(Date.parse('2026-07-09T23:59:59.999Z'));
  });

  it('honours a custom cap', () => {
    expect(JSON.parse(buildSmsFilter(WINDOW, 25)).maxCount).toBe(25);
  });

  it('omits an unparseable bound rather than sending NaN', () => {
    const filter = JSON.parse(buildSmsFilter({ from: 'not-a-date', to: '2026-07-08' }));
    expect('minDate' in filter).toBe(false);
    expect(filter.maxDate).toBe(Date.parse('2026-07-09T23:59:59.999Z'));
  });
});

describe('mapSmsRow', () => {
  it('carries body, received time and sender across', () => {
    const message = mapSmsRow({
      body: 'Rs 500 debited',
      date: 1_751_356_800_000,
      address: 'HDFCBK',
    });
    expect(message).toEqual({
      body: 'Rs 500 debited',
      receivedAt: new Date(1_751_356_800_000).toISOString(),
      sender: 'HDFCBK',
    });
  });

  it('accepts a stringified epoch', () => {
    const message = mapSmsRow({ body: 'x', date: '1751356800000' });
    expect(message?.receivedAt).toBe(new Date(1_751_356_800_000).toISOString());
  });

  it('drops a message with no body', () => {
    expect(mapSmsRow({ body: '   ', date: 1 })).toBeNull();
    expect(mapSmsRow({ date: 1 })).toBeNull();
  });

  it('falls back to now when the date is missing or junk, without throwing', () => {
    const before = Date.now();
    const message = mapSmsRow({ body: 'x', date: null });
    const stamp = Date.parse(message!.receivedAt);
    expect(stamp).toBeGreaterThanOrEqual(before);
    expect(mapSmsRow({ body: 'x', date: 'nonsense' })?.receivedAt).toBeTruthy();
  });

  it('leaves the sender off when there is no address', () => {
    expect(mapSmsRow({ body: 'x', date: 1 })).not.toHaveProperty('sender');
    expect(mapSmsRow({ body: 'x', date: 1, address: '  ' })).not.toHaveProperty('sender');
  });
});

describe('parseSmsList', () => {
  it('maps a well-formed payload and skips bodiless rows', () => {
    const messages = parseSmsList(
      JSON.stringify([
        { body: 'Rs 500 debited', date: 1 },
        { body: '', date: 2 },
        { date: 3 },
        { body: 'Rs 90 spent', date: 4 },
      ]),
    );
    expect(messages.map((m) => m.body)).toEqual(['Rs 500 debited', 'Rs 90 spent']);
  });

  it('returns nothing for malformed JSON', () => {
    expect(parseSmsList('{not json')).toEqual([]);
  });

  it('returns nothing for a non-array', () => {
    expect(parseSmsList(JSON.stringify({ body: 'x' }))).toEqual([]);
  });
});

// ─────────────────────────────────────────────── readSmsInbox matrix ──

describe('readSmsInbox — refusals', () => {
  it('is unsupported off Android', async () => {
    const res = await readSmsInbox(WINDOW, deps({ platformOS: 'ios' }));
    expect(res).toEqual({ ok: false, reason: 'unsupported' });
  });

  it('is unavailable when the module is not in this build', async () => {
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => null }));
    expect(res).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is unavailable — not a crash — when loading the module throws', async () => {
    const res = await readSmsInbox(
      WINDOW,
      deps({
        loadModule: () => {
          throw new Error('native side blew up');
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('is unavailable when the module has no list method', async () => {
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => ({}) as NativeSmsModule }));
    expect(res).toEqual({ ok: false, reason: 'unavailable' });
  });

  it('reports a plain denial', async () => {
    const res = await readSmsInbox(WINDOW, deps({ requestPermission: async () => 'denied' }));
    expect(res).toEqual({ ok: false, reason: 'denied' });
  });

  it('reports a blocked (never-ask-again) permission distinctly', async () => {
    const res = await readSmsInbox(WINDOW, deps({ requestPermission: async () => 'blocked' }));
    expect(res).toEqual({ ok: false, reason: 'blocked' });
  });

  it('does not ask for permission before the module is known to exist', async () => {
    const requestPermission = vi.fn(async () => 'granted' as const);
    await readSmsInbox(WINDOW, deps({ loadModule: () => null, requestPermission }));
    expect(requestPermission).not.toHaveBeenCalled();
  });
});

describe('readSmsInbox — reading', () => {
  it('returns the parsed messages on success', async () => {
    const rows = [
      { body: 'Rs 500 debited at SWIGGY', date: 1_751_356_800_000, address: 'HDFCBK' },
      { body: 'Rs 90 spent at CCD', date: 1_751_443_200_000, address: 'HDFCBK' },
    ];
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => moduleReturning(rows) }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.messages).toHaveLength(2);
  });

  it('passes the window filter through to the native call', async () => {
    let seen = '';
    const module: NativeSmsModule = {
      list: (filter, _fail, success) => {
        seen = filter;
        success(0, '[]');
      },
    };
    await readSmsInbox(WINDOW, deps({ loadModule: () => module, maxCount: 42 }));
    const parsed = JSON.parse(seen);
    expect(parsed.maxCount).toBe(42);
    expect(parsed.minDate).toBe(Date.parse('2026-06-30T00:00:00.000Z'));
  });

  it('surfaces a read failure with its message', async () => {
    const module: NativeSmsModule = {
      list: (_filter, fail) => fail('cursor closed'),
    };
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => module }));
    expect(res).toEqual({ ok: false, reason: 'failed', message: 'cursor closed' });
  });

  it('turns a synchronous throw from list into a failure, not a crash', async () => {
    const module: NativeSmsModule = {
      list: () => {
        throw new Error('binder died');
      },
    };
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => module }));
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('failed');
      expect(res.message).toBe('binder died');
    }
  });

  it('resolves once even if the native side calls back twice', async () => {
    const module: NativeSmsModule = {
      list: (_filter, fail, success) => {
        success(1, JSON.stringify([{ body: 'Rs 500 debited', date: 1 }]));
        success(1, JSON.stringify([{ body: 'Rs 999 debited', date: 2 }]));
        fail('late error');
      },
    };
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => module }));
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.messages[0]?.body).toBe('Rs 500 debited');
  });

  it('returns an empty list for an empty inbox', async () => {
    const res = await readSmsInbox(WINDOW, deps({ loadModule: () => moduleReturning([]) }));
    expect(res).toEqual({ ok: true, messages: [] });
  });
});

// ─────────────────────────────────────── the whole path, end to end ──

describe('read → propose, over the trip window', () => {
  it('surfaces a dated debit inside the trip and drops what does not belong', async () => {
    const rows = [
      // A clean debit, inside the window — the one we want.
      {
        body: 'Rs 1,250.00 debited at ANJAPPAR on 04-Jul-26. UPI Ref 412345678901',
        date: Date.parse('2026-07-04T13:00:00.000Z'),
        address: 'AD-HDFCBK',
      },
      // A credit — money coming in is never an expense.
      {
        body: 'Rs 5,000 credited to your account on 05-Jul-26',
        date: Date.parse('2026-07-05T09:00:00.000Z'),
        address: 'AD-HDFCBK',
      },
      // An OTP quoting a real amount — the dangerous false positive.
      {
        body: 'Rs 800 is your OTP. Do not share it.',
        date: Date.parse('2026-07-04T10:00:00.000Z'),
        address: 'VM-HDFCBK',
      },
      // A real debit, but received months after the trip window closed.
      {
        body: 'Rs 300 debited at METRO on 02-Aug-26',
        date: Date.parse('2026-08-02T10:00:00.000Z'),
        address: 'AD-HDFCBK',
      },
    ];

    const read = await readSmsInbox(WINDOW, deps({ loadModule: () => moduleReturning(rows) }));
    expect(read.ok).toBe(true);
    if (!read.ok) return;

    const candidates = proposeFromSms(read.messages, { from: WINDOW.from, to: WINDOW.to });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.merchant).toBe('ANJAPPAR');
    expect(candidates[0]?.amount.minor).toBe(125000n);
    expect(candidates[0]?.direction).toBe('debit');
  });

  it('places a dateless message on the day it was received, so the window still holds', async () => {
    const rows = [
      {
        body: 'Rs 640 spent at BLUE TOKAI',
        date: Date.parse('2026-07-03T08:00:00.000Z'),
        address: 'AD-ICICIB',
      },
    ];
    const read = await readSmsInbox(WINDOW, deps({ loadModule: () => moduleReturning(rows) }));
    if (!read.ok) throw new Error('expected a successful read');

    const inside = proposeFromSms(read.messages, { from: WINDOW.from, to: WINDOW.to });
    expect(inside).toHaveLength(1);
    expect(inside[0]?.dateInferred).toBe(true);

    // The same message, asked for a window that ends before it arrived, is gone.
    const outside = proposeFromSms(read.messages, { from: '2026-06-01', to: '2026-06-30' });
    expect(outside).toHaveLength(0);
  });

  it('drops what has already been imported', async () => {
    const rows = [
      {
        body: 'Rs 1,250.00 debited at ANJAPPAR on 04-Jul-26. UPI Ref 412345678901',
        date: Date.parse('2026-07-04T13:00:00.000Z'),
        address: 'AD-HDFCBK',
      },
    ];
    const read = await readSmsInbox(WINDOW, deps({ loadModule: () => moduleReturning(rows) }));
    if (!read.ok) throw new Error('expected a successful read');

    const alreadyImported = new Set(['ref:412345678901']);
    const candidates = proposeFromSms(read.messages, {
      from: WINDOW.from,
      to: WINDOW.to,
      alreadyImported,
    });
    expect(candidates).toHaveLength(0);
  });
});
