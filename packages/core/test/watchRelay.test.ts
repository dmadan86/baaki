import { describe, expect, it } from 'vitest';

import {
  coerceRecentCount,
  DEFAULT_RECENT_COUNT,
  encodePhoneToWatch,
  parseWatchToPhone,
  WATCH_RELAY_VERSION,
} from '../src/watch/relay';

describe('coerceRecentCount', () => {
  it('accepts the offered sizes and defaults everything else', () => {
    expect(coerceRecentCount(3)).toBe(3);
    expect(coerceRecentCount(5)).toBe(5);
    expect(coerceRecentCount(10)).toBe(10);
    expect(coerceRecentCount(7)).toBe(DEFAULT_RECENT_COUNT);
    expect(coerceRecentCount('5')).toBe(5);
    expect(coerceRecentCount(undefined)).toBe(DEFAULT_RECENT_COUNT);
    expect(coerceRecentCount(null)).toBe(DEFAULT_RECENT_COUNT);
  });
});

describe('parseWatchToPhone', () => {
  it('accepts a well-formed quickAdd', () => {
    expect(
      parseWatchToPhone({
        t: 'quickAdd',
        id: 'w1',
        amountMinor: '1200',
        currency: 'INR',
        note: 'Lunch',
      }),
    ).toEqual({ t: 'quickAdd', id: 'w1', amountMinor: '1200', currency: 'INR', note: 'Lunch' });
  });

  it('rejects a quickAdd with a non-integer, zero, negative, or empty-currency amount', () => {
    expect(
      parseWatchToPhone({
        t: 'quickAdd',
        id: 'w1',
        amountMinor: '12.5',
        currency: 'INR',
        note: '',
      }),
    ).toBeNull();
    expect(
      parseWatchToPhone({ t: 'quickAdd', id: 'w1', amountMinor: '0', currency: 'INR', note: '' }),
    ).toBeNull();
    // Leading-zero zero: BigInt('00') is 0n, so this must be rejected too.
    expect(
      parseWatchToPhone({ t: 'quickAdd', id: 'w1', amountMinor: '00', currency: 'INR', note: '' }),
    ).toBeNull();
    expect(
      parseWatchToPhone({ t: 'quickAdd', id: 'w1', amountMinor: '-5', currency: 'INR', note: '' }),
    ).toBeNull();
    expect(
      parseWatchToPhone({ t: 'quickAdd', id: 'w1', amountMinor: '100', currency: '', note: '' }),
    ).toBeNull();
  });

  it('accepts a versionless (v1) message and rejects an explicit version mismatch', () => {
    expect(
      parseWatchToPhone({ t: 'requestRecent', count: 5, version: WATCH_RELAY_VERSION }),
    ).not.toBeNull();
    expect(parseWatchToPhone({ t: 'requestRecent', count: 5, version: 999 })).toBeNull();
    // No version field at all = a v1 watch, still accepted.
    expect(parseWatchToPhone({ t: 'requestRecent', count: 5 })).not.toBeNull();
  });

  it('accepts an empty note (money is enough for a capture)', () => {
    expect(
      parseWatchToPhone({ t: 'quickAdd', id: 'w1', amountMinor: '100', currency: 'INR', note: '' }),
    ).not.toBeNull();
  });

  it('accepts a non-empty voiceAdd and rejects a blank one', () => {
    expect(parseWatchToPhone({ t: 'voiceAdd', id: 'w1', transcript: 'add 500 to goa' })).toEqual({
      t: 'voiceAdd',
      id: 'w1',
      transcript: 'add 500 to goa',
    });
    expect(parseWatchToPhone({ t: 'voiceAdd', id: 'w1', transcript: '   ' })).toBeNull();
  });

  it('rejects a quickAdd or voiceAdd with no idempotency id', () => {
    expect(
      parseWatchToPhone({ t: 'quickAdd', amountMinor: '100', currency: 'INR', note: '' }),
    ).toBeNull();
    expect(parseWatchToPhone({ t: 'voiceAdd', transcript: 'add 500' })).toBeNull();
  });

  it('clamps requestRecent count to an offered size', () => {
    expect(parseWatchToPhone({ t: 'requestRecent', count: 99 })).toEqual({
      t: 'requestRecent',
      count: DEFAULT_RECENT_COUNT,
    });
    expect(parseWatchToPhone({ t: 'requestRecent', count: 10 })).toEqual({
      t: 'requestRecent',
      count: 10,
    });
  });

  it('requires both ids on a notifAction', () => {
    expect(parseWatchToPhone({ t: 'notifAction', actionId: 'remind', objectId: 'x' })).toEqual({
      t: 'notifAction',
      actionId: 'remind',
      objectId: 'x',
    });
    expect(parseWatchToPhone({ t: 'notifAction', actionId: 'remind', objectId: '' })).toBeNull();
  });

  it('rejects unknown types and non-objects', () => {
    expect(parseWatchToPhone({ t: 'nope' })).toBeNull();
    expect(parseWatchToPhone(null)).toBeNull();
    expect(parseWatchToPhone('quickAdd')).toBeNull();
    expect(parseWatchToPhone(42)).toBeNull();
  });
});

describe('encodePhoneToWatch', () => {
  it('stamps the relay version onto every outbound message', () => {
    expect(encodePhoneToWatch({ t: 'settings', recentCount: 5, currency: 'INR' })).toEqual({
      version: WATCH_RELAY_VERSION,
      t: 'settings',
      recentCount: 5,
      currency: 'INR',
    });
    expect(encodePhoneToWatch({ t: 'ack', ok: true })).toEqual({
      version: WATCH_RELAY_VERSION,
      t: 'ack',
      ok: true,
    });
  });
});
