/**
 * The link that says it will send you a code, and where it actually goes.
 *
 * The bug these pin: the sign-in field's placeholder is "Email or phone
 * number", and typing a phone number into it then tapping the only visible
 * "send me a code" answered "Enter your email first" — on a build that could
 * text a code perfectly well, from a tile below the fold that the keyboard was
 * covering.
 */

import { describe, expect, it } from 'vitest';

import { CodeRoute, codeRouteFor, looksLikeEmail, looksLikePhone } from '@/lib/authCodeRoute';

describe('telling one kind of identifier from the other', () => {
  it('reads an address as an address', () => {
    expect(looksLikeEmail('madan@example.com')).toBe(true);
    expect(looksLikeEmail('  madan@example.co.in  ')).toBe(true);
  });

  it('does not read a number as an address', () => {
    expect(looksLikeEmail('+919876543210')).toBe(false);
    expect(looksLikeEmail('9876543210')).toBe(false);
  });

  it('reads a number with or without its country code', () => {
    expect(looksLikePhone('+919876543210')).toBe(true);
    expect(looksLikePhone('9876543210')).toBe(true);
  });

  it('ignores the punctuation people type into a phone field', () => {
    expect(looksLikePhone('+91 98765 43210')).toBe(true);
    expect(looksLikePhone('(020) 7946 0958')).toBe(true);
    expect(looksLikePhone('+1-415-555-0123')).toBe(true);
  });

  it('does not read an address, a word, or an essay as a number', () => {
    expect(looksLikePhone('madan@example.com')).toBe(false);
    expect(looksLikePhone('madan')).toBe(false);
    expect(looksLikePhone('')).toBe(false);
    // Too short to be a number anywhere.
    expect(looksLikePhone('12345')).toBe(false);
    // Past E.164's own ceiling of 15 digits.
    expect(looksLikePhone('1234567890123456')).toBe(false);
  });
});

describe('where the code link goes', () => {
  it('mails a code to an address, on any build', () => {
    expect(codeRouteFor('madan@example.com', true)).toBe(CodeRoute.Email);
    expect(codeRouteFor('madan@example.com', false)).toBe(CodeRoute.Email);
  });

  it('carries a number to the phone screen instead of refusing it', () => {
    // The whole point of the change.
    expect(codeRouteFor('+919876543210', true)).toBe(CodeRoute.Phone);
    expect(codeRouteFor('9876543210', true)).toBe(CodeRoute.Phone);
  });

  it('refuses a number on a build with no phone door', () => {
    // Firebase is a native module. On a binary made before it existed, the
    // "Continue with phone" tile is absent, and a link that promised a text
    // would lead exactly where that tile does not go.
    expect(codeRouteFor('+919876543210', false)).toBe(CodeRoute.Nothing);
  });

  it('refuses what is neither', () => {
    expect(codeRouteFor('madan', true)).toBe(CodeRoute.Nothing);
    expect(codeRouteFor('', true)).toBe(CodeRoute.Nothing);
    expect(codeRouteFor('   ', true)).toBe(CodeRoute.Nothing);
  });

  it('never sends an address to the phone screen', () => {
    // An address with digits in it is still an address.
    expect(codeRouteFor('9876543210@example.com', true)).toBe(CodeRoute.Email);
  });
});
