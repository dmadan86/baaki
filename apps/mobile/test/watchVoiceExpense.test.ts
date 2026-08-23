/**
 * "Say five hundred rupees, tea shop" — from the wrist to a booked expense.
 *
 * This walks the whole watch→phone path with the exact words a person speaks,
 * and asserts an expense comes out the far end with the right money on it:
 *
 *   WatchRelay.voiceAdd(transcript)   targets/watch/WavesWatchApp.swift
 *     → parseWatchToPhone             @waves/core relay contract, the decoder
 *     → parseVoiceExpenses            the phone's voice parser
 *     → createCapture({ amount })     what the bridge writes to the queue
 *
 * The one thing it cannot cover is the microphone: dictation is a system
 * service, and the watchOS Simulator has no audio capture at all (Quickboard
 * reports `dictationLanguage = nil` and CoreMedia fails to allocate), so no
 * automated test on a Mac can speak. It therefore starts where dictation
 * finishes — at the transcript string — which is also exactly where a bug hid:
 * every amount pattern in the parser is digit-based, and people say "five
 * hundred", not "500".
 */

import { describe, expect, it } from 'vitest';

import { parseWatchToPhone } from '@waves/core';

import { parseVoiceExpenses, type VoiceGroupRef } from '@/lib/voiceExpense';

/** The message the watch's `voiceAdd` puts on the wire (WavesWatchApp.swift). */
function watchSaid(transcript: string) {
  return { t: 'voiceAdd', id: 'watch-intent-1', transcript, version: 1 };
}

/**
 * The bridge's voiceAdd arm (src/lib/watch/bridge.tsx), reduced to what it
 * decides: parse the transcript, drop anything without money on it, and book
 * the rest as unassigned captures.
 */
function bridgeVoiceAdd(raw: unknown, groups: readonly VoiceGroupRef[]) {
  const msg = parseWatchToPhone(raw);
  if (!msg || msg.t !== 'voiceAdd') return { ack: false, error: 'rejected', captures: [] };

  const items = parseVoiceExpenses(msg.transcript, groups).items.filter(
    (item) => item.amountMinor > 0n,
  );
  if (items.length === 0) return { ack: false, error: 'no-amount', captures: [] };

  return {
    ack: true,
    error: null,
    captures: items.map((item, i) => ({
      // The single-expense case reuses the watch's intent id, so a replayed
      // utterance upserts instead of duplicating.
      captureId: items.length === 1 ? msg.id : undefined,
      amountMinor: item.amountMinor,
      currency: item.currency,
      description: item.note,
      index: i,
    })),
  };
}

const noGroups: VoiceGroupRef[] = [];

describe('speaking an expense into the watch', () => {
  it('books ₹500 from "five hundred rupees tea shop"', () => {
    const result = bridgeVoiceAdd(watchSaid('five hundred rupees tea shop'), noGroups);

    expect(result.ack).toBe(true);
    expect(result.captures).toHaveLength(1);

    const [capture] = result.captures;
    // 500 rupees in minor units.
    expect(capture.amountMinor).toBe(50000n);
    expect(capture.currency).toBe('INR');
    expect(capture.description).toBe('tea shop');
    // Reused so a transport retry of the same utterance is idempotent.
    expect(capture.captureId).toBe('watch-intent-1');
  });

  it('hears the amount whether it is spoken or dictated as digits', () => {
    for (const said of [
      'five hundred rupees tea shop',
      '500 rupees tea shop',
      'add five hundred rupees to tea shop',
      'five hundred rupees t shop',
    ]) {
      const result = bridgeVoiceAdd(watchSaid(said), noGroups);
      expect(result.ack, said).toBe(true);
      expect(result.captures[0]?.amountMinor, said).toBe(50000n);
    }
  });

  it('carries spoken tens, compounds and Indian scales through', () => {
    const cases: [string, bigint][] = [
      ['twenty rupees chai', 2000n],
      ['fifty rupees auto', 5000n],
      ['two thousand rupees hotel', 200000n],
      ['five hundred and fifty rupees dinner', 55000n],
      ['one lakh rupees deposit', 10000000n],
    ];
    for (const [said, expected] of cases) {
      const result = bridgeVoiceAdd(watchSaid(said), noGroups);
      expect(result.ack, said).toBe(true);
      expect(result.captures[0]?.amountMinor, said).toBe(expected);
    }
  });

  it('tells the watch when nothing it heard was money', () => {
    const result = bridgeVoiceAdd(watchSaid('remind me about the tea shop'), noGroups);
    expect(result.ack).toBe(false);
    expect(result.error).toBe('no-amount');
    expect(result.captures).toHaveLength(0);
  });

  it('does not invent an amount out of ordinary speech', () => {
    // "one" and "two" here are words, not money — a parser that turned every
    // number word into digits would book a ₹1 expense for this sentence.
    const result = bridgeVoiceAdd(watchSaid('one of us paid at the tea shop'), noGroups);
    expect(result.ack).toBe(false);
    expect(result.error).toBe('no-amount');
  });

  it('refuses a malformed intent before it can reach the queue', () => {
    expect(bridgeVoiceAdd({ t: 'voiceAdd', id: '', transcript: 'five hundred rupees' }, noGroups).ack)
      .toBe(false);
    expect(bridgeVoiceAdd({ t: 'voiceAdd', id: 'x', transcript: '   ' }, noGroups).ack).toBe(false);
    // A version the phone cannot read is rejected rather than guessed at.
    expect(
      bridgeVoiceAdd({ t: 'voiceAdd', id: 'x', transcript: 'five hundred rupees', version: 99 }, noGroups)
        .ack,
    ).toBe(false);
  });
});
