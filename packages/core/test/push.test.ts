/**
 * Fanning a notification out to phones, and reading back what happened.
 *
 * Three ways this goes wrong quietly, all of them here rather than in the edge
 * function where they would need a network and a handset to reproduce:
 *
 *   * the reply comes back as one flat array in send order, so losing the
 *     mapping revokes a live device because a dead one failed;
 *   * a push in the wrong language, or in English when the inbox says Tamil,
 *     because the row was written by Postgres and rendered by nobody;
 *   * marking everything failed for somebody who owns an old tablet.
 */

import { describe, expect, it } from 'vitest';

import {
  buildPushBatch,
  chunk,
  isPushMisconfigured,
  readPushTickets,
  type PushableNotification,
} from '../src/index';

const NOTIFICATION: PushableNotification = {
  id: 'n1',
  kind: 'trip_nudge_evening',
  title: 'Before you forget',
  body: 'What did you pay for today?',
  deepLink: 'baaki://group/g1/add-expense',
  facts: { group: 'Goa' },
  locale: 'en-IN',
  tokens: ['ExponentPushToken[phone]'],
};

describe('building the batch', () => {
  it('sends one message per device', () => {
    const { messages } = buildPushBatch([{ ...NOTIFICATION, tokens: ['a', 'b', 'c'] }]);
    expect(messages.map((message) => message.to)).toEqual(['a', 'b', 'c']);
  });

  it('says the same thing the inbox says, in the same language', () => {
    const [tamil] = buildPushBatch([{ ...NOTIFICATION, locale: 'ta-IN' }]).messages;
    const [english] = buildPushBatch([NOTIFICATION]).messages;
    expect(tamil?.title).not.toBe(english?.title);
    expect(english?.body).toContain('Goa');
  });

  it('falls back to what the row said for a kind it does not know', () => {
    const [message] = buildPushBatch([{ ...NOTIFICATION, kind: 'invented_next_year' }]).messages;
    expect(message?.title).toBe('Before you forget');
  });

  it('carries what the app needs to open the right screen', () => {
    const [message] = buildPushBatch([NOTIFICATION]).messages;
    expect(message?.data).toMatchObject({
      notificationId: 'n1',
      url: 'baaki://group/g1/add-expense',
    });
  });

  it('asks for a channel, without which Android delivers it silently', () => {
    const [message] = buildPushBatch([NOTIFICATION]).messages;
    expect(message?.channelId).toBe('default');
  });

  it('skips somebody with no devices rather than sending to nobody', () => {
    const { messages, targets } = buildPushBatch([{ ...NOTIFICATION, tokens: [] }]);
    expect(messages).toHaveLength(0);
    expect(targets).toHaveLength(0);
  });

  it('splits at Expo’s hundred, which is a hard limit and not a suggestion', () => {
    const tokens = Array.from({ length: 250 }, (_, index) => `token-${index}`);
    const { messages } = buildPushBatch([{ ...NOTIFICATION, tokens }]);
    expect(chunk(messages).map((batch) => batch.length)).toEqual([100, 100, 50]);
  });
});

describe('reading the tickets', () => {
  const targets = [
    { notificationId: 'n1', token: 'live' },
    { notificationId: 'n1', token: 'uninstalled' },
    { notificationId: 'n2', token: 'also-uninstalled' },
  ];

  it('revokes only the device that is actually gone', () => {
    // The whole reason the mapping exists. Off by one here and somebody stops
    // getting notifications on the phone they still use.
    const outcome = readPushTickets(targets, [
      { status: 'ok', id: 't1' },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);
    expect(outcome.revoke).toEqual(['uninstalled', 'also-uninstalled']);
  });

  it('counts a notification delivered if any of the person’s devices took it', () => {
    const outcome = readPushTickets(targets, [
      { status: 'ok', id: 't1' },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);
    expect(outcome.delivered).toEqual(['n1']);
    expect(outcome.failed).toEqual(['n2']);
  });

  it('does not revoke a token over a transient failure', () => {
    // A rate limit is not an uninstall, and treating it as one loses the device
    // permanently over a bad minute.
    const outcome = readPushTickets(targets.slice(0, 1), [
      { status: 'error', message: 'Too many requests', details: { error: 'MessageRateExceeded' } },
    ]);
    expect(outcome.revoke).toEqual([]);
    expect(outcome.failed).toEqual(['n1']);
  });

  it('treats a truncated reply as unsent rather than sent', () => {
    // Marking a notification delivered because the answer was short is how a
    // person never hears about it and the table says they did.
    const outcome = readPushTickets(targets, [{ status: 'ok', id: 't1' }]);
    expect(outcome.delivered).toEqual(['n1']);
    expect(outcome.failed).toEqual(['n2']);
    expect(outcome.problems).toEqual([{ error: 'no_ticket', count: 2 }]);
  });
});

describe('telling a wrong FCM key apart from a country with its phones off', () => {
  const targets = [
    { notificationId: 'n1', token: 'a' },
    { notificationId: 'n2', token: 'b' },
    { notificationId: 'n3', token: 'c' },
  ];

  it('names the credential error rather than counting three more failures', () => {
    // This is what a build whose google-services.json does not match the FCM
    // key Expo holds looks like: every ticket errors, and without the code
    // there is nothing anywhere to distinguish it from bad luck.
    const outcome = readPushTickets(targets, [
      { status: 'error', details: { error: 'MismatchSenderId' } },
      { status: 'error', details: { error: 'MismatchSenderId' } },
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
    ]);

    expect(outcome.problems).toEqual([
      { error: 'MismatchSenderId', count: 2 },
      { error: 'DeviceNotRegistered', count: 1 },
    ]);
    expect(isPushMisconfigured(outcome.problems)).toBe(true);
    // And the one real uninstall is still revoked, not lost in the noise.
    expect(outcome.revoke).toEqual(['c']);
  });

  it('does not cry misconfiguration over uninstalled apps', () => {
    const outcome = readPushTickets(targets, [
      { status: 'error', details: { error: 'DeviceNotRegistered' } },
      { status: 'error', details: { error: 'MessageRateExceeded' } },
      { status: 'ok', id: 't1' },
    ]);
    expect(isPushMisconfigured(outcome.problems)).toBe(false);
  });

  it('says something even when Expo says nothing', () => {
    const outcome = readPushTickets(targets.slice(0, 1), [{ status: 'error' }]);
    expect(outcome.problems).toEqual([{ error: 'unknown', count: 1 }]);
  });

  it('reports the same run the same way twice', () => {
    // Two errors with the same count would otherwise come out in Map insertion
    // order, and a log that reorders itself is a log nobody trusts.
    const tickets = [
      { status: 'error', details: { error: 'MessageTooBig' } },
      { status: 'error', details: { error: 'InvalidCredentials' } },
      { status: 'error', details: { error: 'MessageTooBig' } },
    ];
    const forwards = readPushTickets(targets, tickets);
    const backwards = readPushTickets([...targets].reverse(), [...tickets].reverse());
    expect(forwards.problems).toEqual(backwards.problems);
    expect(forwards.problems[0]).toEqual({ error: 'MessageTooBig', count: 2 });
  });

  it('is quiet when everything worked', () => {
    const outcome = readPushTickets(targets, [
      { status: 'ok', id: 't1' },
      { status: 'ok', id: 't2' },
      { status: 'ok', id: 't3' },
    ]);
    expect(outcome.problems).toEqual([]);
    expect(isPushMisconfigured(outcome.problems)).toBe(false);
  });
});
