/**
 * Dictation, minus the microphone.
 *
 * The three things that can be wrong without anybody noticing on the device
 * they happen to be holding: recognising the wrong language, eating what was
 * already typed, and turning a platform error code into a blank screen.
 */

import { describe, expect, it, vi } from 'vitest';

import { dictationError, mergeTranscript, speechLocale } from '@/lib/dictation';
import { Language } from '@/i18n';

// The Language enum lives in the i18n module, which imports expo-localization
// (and through it react-native) at load. This test only needs the enum, so the
// native dependency is stubbed out — the same shim language.test.ts uses.
vi.mock('expo-localization', () => ({ getLocales: () => [] }));

describe('speechLocale', () => {
  it('keeps the phone’s own region when it agrees with the app language', () => {
    // Somebody in London is recognised as British English, not corrected to
    // Indian English because the app happens to be India-first.
    expect(speechLocale(Language.En, 'en-GB')).toBe('en-GB');
    expect(speechLocale(Language.Ta, 'ta-LK')).toBe('ta-LK');
  });

  it('falls back to India when the tag carries no region', () => {
    // Bare "ta" is a lottery on Android — some recognisers take it, some
    // return language-not-supported.
    expect(speechLocale(Language.Ta, 'ta')).toBe('ta-IN');
    expect(speechLocale(Language.Hi, 'hi')).toBe('hi-IN');
  });

  it('follows the app language, not the phone, when they disagree', () => {
    // The app is showing Tamil, so Tamil is what the user is about to speak.
    expect(speechLocale(Language.Ta, 'en-US')).toBe('ta-IN');
  });

  it('survives the shapes a locale tag actually arrives in', () => {
    expect(speechLocale(Language.En, 'en_IN')).toBe('en-IN');
    expect(speechLocale(Language.En, 'en-in')).toBe('en-IN');
    expect(speechLocale(Language.En, '')).toBe('en-IN');
  });
});

describe('mergeTranscript', () => {
  it('adds to what was already typed', () => {
    expect(mergeTranscript('Dinner', 'at the beach shack')).toBe('Dinner at the beach shack');
  });

  it('does not double the space at the join', () => {
    expect(mergeTranscript('Dinner ', 'at the shack')).toBe('Dinner at the shack');
    expect(mergeTranscript('Dinner', '  at the shack ')).toBe('Dinner at the shack');
  });

  it('is the transcript alone when the field was empty', () => {
    expect(mergeTranscript('', 'Auto to the airport')).toBe('Auto to the airport');
  });

  it('leaves the field alone when nothing was heard', () => {
    expect(mergeTranscript('Dinner', '')).toBe('Dinner');
    expect(mergeTranscript('Dinner', '   ')).toBe('Dinner');
  });

  it('is stable across interim results, which arrive in full each time', () => {
    // This is the property that matters: interim results are re-issued whole,
    // so merging must be recomputed from the same starting text rather than
    // appended, or the note reads "Dinner dinner at dinner at the".
    const before = 'Dinner';
    const interim = ['at', 'at the', 'at the beach shack'];
    const rendered = interim.map((text) => mergeTranscript(before, text));
    expect(rendered.at(-1)).toBe('Dinner at the beach shack');
    expect(new Set(rendered).size).toBe(interim.length);
  });
});

describe('dictationError', () => {
  it('says what to do about a refused microphone', () => {
    expect(dictationError('not-allowed')).toMatch(/Settings/);
    expect(dictationError('service-not-allowed')).toMatch(/Settings/);
  });

  it('stays quiet when the user stopped it themselves', () => {
    // Stopping emits `aborted`. Telling somebody their own tap was an error is
    // how an app teaches people to ignore its messages.
    expect(dictationError('aborted')).toBe('');
  });

  it('still says something useful for a code it has never seen', () => {
    expect(dictationError('some-future-code')).not.toBe('');
  });

  it('never leaves somebody without a way forward', () => {
    const codes = ['no-speech', 'audio-capture', 'network', 'language-not-supported', 'client'];
    for (const code of codes) {
      expect(dictationError(code)).toMatch(/try again|Type the note|speak again/i);
    }
  });
});
