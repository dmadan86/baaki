/**
 * The parts of dictation that are not the microphone.
 *
 * Kept free of React and of the native module so they can be tested without a
 * device: which language to recognise in, how a transcript joins whatever is
 * already in the field, and what to tell somebody when it fails. All three have
 * been quietly wrong in other apps — recognising English while somebody speaks
 * Tamil, replacing what they typed instead of adding to it, and showing
 * "error 7".
 */

import type { Language } from '@/i18n';

/**
 * The BCP-47 tag to recognise in.
 *
 * The device's own tag wins when it agrees with the language the app is showing
 * — somebody on `en-GB` should be recognised as `en-GB`, not corrected to
 * Indian English. When it disagrees, or carries no region, India is the
 * fallback: Baaki is India-first, and `ta`/`hi` with no region is a recogniser
 * lottery on Android.
 */
export function speechLocale(language: Language, deviceLocale: string): string {
  const [tag, region] = deviceLocale.trim().split(/[-_]/);
  if (tag?.toLowerCase() === language && region) return `${language}-${region.toUpperCase()}`;
  return `${language}-IN`;
}

/**
 * What the field should read while somebody is speaking.
 *
 * `before` is whatever was in the field when the mic was tapped, and it is
 * never thrown away: dictation adds to a note, it does not replace one. The
 * transcript is recomputed from `before` on every interim result rather than
 * appended, because interim results are re-issued in full — appending them
 * gives you "dinner dinner at dinner at the".
 */
export function mergeTranscript(before: string, transcript: string): string {
  const spoken = transcript.trim();
  if (!spoken) return before;
  const kept = before.trimEnd();
  return kept ? `${kept} ${spoken}` : spoken;
}

/**
 * Every error this can end on, in words.
 *
 * The codes are the Web Speech API's, which both native implementations are
 * mapped onto. Anything unrecognised gets a sentence that is still true, so a
 * new code in a future version is a vague message rather than a blank one.
 */
export function dictationError(code: string): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return 'Baaki needs permission to use the microphone. You can turn it on in Settings.';
    case 'no-speech':
      return 'Did not catch anything. Tap the mic and speak again.';
    case 'audio-capture':
      return 'The microphone is busy. Close anything else that is recording and try again.';
    case 'network':
      return 'Speech recognition needs a connection on this phone. Type the note instead.';
    case 'language-not-supported':
      return 'This phone cannot recognise that language yet. Type the note instead.';
    // Not an error anybody needs telling about: it is what stopping produces.
    case 'aborted':
      return '';
    default:
      return 'Dictation stopped. Type the note instead.';
  }
}
