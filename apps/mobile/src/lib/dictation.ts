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

import type { DictationErrorStrings, Language } from '@/i18n';

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
  const parts = deviceLocale.trim().split(/[-_]/);
  const tag = parts[0];
  // Skip a script subtag (e.g. `zh-Hans-CN`): only a two-letter region or a
  // three-digit UN M.49 code is a real region the recogniser can match.
  const region = parts.slice(1).find((part) => /^([A-Za-z]{2}|\d{3})$/.test(part));
  if (tag?.toLowerCase() === language && region) return `${language}-${region.toUpperCase()}`;
  return `${language}-IN`;
}

/**
 * The English tag to recognise in, keeping the device's region whatever the UI
 * language is.
 *
 * The capture flow always recognises English (its parser is English-only), so
 * the region must be taken from the device independently of the shown language:
 * a phone on `ar-AE` should hear `en-AE`, not be corrected to Indian English the
 * way {@link speechLocale} would (it keeps a region only when the tag already
 * matches the language). India is the fallback only when the device carries no
 * region at all.
 */
export function englishSpeechLocale(deviceLocale: string): string {
  const parts = deviceLocale.trim().split(/[-_]/);
  // A two-letter region or a three-digit UN M.49 code — never a script subtag.
  const region = parts.slice(1).find((part) => /^([A-Za-z]{2}|\d{3})$/.test(part));
  return region ? `en-${region.toUpperCase()}` : 'en-IN';
}

/**
 * Whether an on-device model for `langTag` is covered by the phone's list of
 * installed locales — kept pure (no native module) so the matching itself can be
 * tested without a device.
 *
 * The trap this avoids: matching on the language subtag alone treats every
 * regional model as interchangeable, so a phone with only `en-US` installed
 * would be told it has `en-IN` — and asking the recogniser for an on-device
 * model that is not there returns silence (the "did not catch anything" bug).
 * So two *regioned* tags must match in full: `en-US` does not satisfy `en-IN`.
 *
 * A language-only entry is the one wildcard: Android commonly lists an installed
 * model as just `en`, meaning the generic English model, which does cover any
 * region of English. So `en` (installed) covers `en-IN` (wanted), and a bare
 * `en` request is covered by any installed English. Only when both sides name a
 * region must those regions agree.
 */
export function onDeviceLocaleInstalled(
  langTag: string,
  installedLocales: readonly string[] | null | undefined,
): boolean {
  const norm = (tag: string): string => tag.trim().replace(/_/g, '-').toLowerCase();
  const want = norm(langTag);
  if (!want) return false;
  const wantLang = want.split('-')[0];
  const wantHasRegion = want.includes('-');
  return (installedLocales ?? []).some((raw) => {
    const tag = norm(raw);
    if (!tag) return false;
    if (tag.split('-')[0] !== wantLang) return false;
    const tagHasRegion = tag.includes('-');
    // A language-only entry on either side is the generic model: it covers the
    // whole language. Only when both carry a region must the regions match.
    if (!tagHasRegion || !wantHasRegion) return true;
    return tag === want;
  });
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
export function dictationError(code: string, messages: DictationErrorStrings): string {
  switch (code) {
    case 'not-allowed':
    case 'service-not-allowed':
      return messages.notAllowed;
    case 'no-speech':
      return messages.noSpeech;
    case 'audio-capture':
      return messages.audioBusy;
    case 'network':
      return messages.network;
    case 'language-not-supported':
      return messages.languageNotSupported;
    // Not an error anybody needs telling about: it is what stopping produces.
    case 'aborted':
      return '';
    default:
      return messages.stopped;
  }
}
