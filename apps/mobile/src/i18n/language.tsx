/**
 * Which language the app is in, and which way it runs.
 *
 * The phone's language is the default and stays the default. This exists
 * because a phone is one setting for one person, and the two do not always
 * agree: somebody in Chennai whose phone is in English still reads Tamil
 * faster, and somebody visiting from Dubai has a phone in Arabic and a group
 * full of people who do not read it.
 *
 * ## The restart, and why it is not hidden
 *
 * Strings change instantly — they are React state and nothing else. Direction
 * does not. React Native decides right-to-left once, natively, before any
 * JavaScript runs, and `I18nManager.forceRTL` says so itself: *changes take
 * full effect on the next application start*. So the app restarts itself, via
 * `@/lib/restart` — and asks first, because throwing somebody out of the screen
 * they are standing on is not something to do without permission.
 *
 * A build that cannot restart itself — anything older than the one that added
 * `expo-updates`, and any reload the platform refuses — still gets the sentence
 * that was always true: close and open Baaki again.
 *
 * Said in an alert, at the moment of the choice, and not only in a banner. A
 * banner lives on one screen; somebody who taps a language and walks away never
 * reads it, comes back to a mirrored English app and reports it as broken. It
 * is worth interrupting for, once, and only when the direction actually turns.
 *
 * `allowRTL` and `forceRTL` are both set, in step, because they answer
 * different halves of the question. Android computes RTL as
 * `forced || (allowed && the device is RTL)`, so `forceRTL(false)` alone would
 * not give an English reader on an Arabic phone a left-to-right app — it only
 * stops *forcing*, and the device pref would win. Setting both makes the choice
 * mean what it says in both directions.
 *
 * ## Icons follow the screen, not the choice
 *
 * `setLayoutDirection` takes the direction the app is *actually laid out in*,
 * which between choosing Arabic and restarting is still the old one. Mirroring
 * the arrows the moment the language changes would put backwards chevrons on an
 * unmirrored screen — a bug that looks exactly like the one it is trying to
 * prevent.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Alert, I18nManager, Platform } from 'react-native';

import { setLayoutDirection } from '@baaki/ui';

import { canRestart, restartApp } from '@/lib/restart';

import {
  deviceLanguage,
  deviceLocale,
  isRtlLanguage,
  LanguageContext,
  localeFor,
  setActiveLanguage,
  STRINGS_BY_LANGUAGE,
  type Language,
} from '@/i18n';

const KEY = 'baaki.language';

/**
 * The direction the app actually launched in.
 *
 * Read once, at module scope, because that is when it was true. `isRTL` comes
 * from native constants captured at startup and does not move when `forceRTL`
 * is called, which is precisely what makes it the right thing to compare a new
 * choice against.
 *
 * Web has no `I18nManager` worth asking — the root view carries a `dir` instead
 * and CSS honours it the moment it changes, so there is nothing to restart and
 * nothing to compare.
 */
const LAUNCHED_RTL = Platform.OS === 'web' ? null : I18nManager.isRTL;

interface LanguageValue {
  /** The language the app is speaking. */
  language: Language;
  /** The explicit choice, or null when it is following the phone. */
  stored: Language | null;
  /** The locale money and dates are formatted in. */
  locale: string;
  /** True while the stored choice is still being read. */
  loading: boolean;
  /** Null puts it back under the phone's control. */
  setLanguage: (value: Language | null) => Promise<void>;
  /** What the phone itself is set to, for explaining the default. */
  phoneLanguage: Language;
  /**
   * True when the chosen language reads the other way from the layout on
   * screen. Only ever true on a device, and only until the app is opened again.
   */
  restartNeeded: boolean;
}

/**
 * The whole value, for the two screens that change it.
 *
 * Separate from `LanguageContext` in `./index` on purpose, and holding the very
 * same object. That one carries the two fields every screen in the app reads
 * through `useStrings`, and it lives beside the string tables — where a setter
 * and a restart flag have no business being, and would drag React Native and
 * AsyncStorage into a module the tests import for its data.
 */
const LanguageValueContext = createContext<LanguageValue | null>(null);

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [stored, setStored] = useState<Language | null>(null);
  const [loading, setLoading] = useState(true);

  const phoneLanguage = deviceLanguage();
  const language = stored ?? phoneLanguage;

  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await AsyncStorage.getItem(KEY).catch(() => null);
      if (!active) return;
      setStored(isLanguage(saved) ? saved : null);
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  // On web the layout mirrors the moment `dir` changes, so the icons have to
  // keep up with the choice. On a device they have to keep up with the launch.
  useEffect(() => {
    setLayoutDirection(LAUNCHED_RTL ?? isRtlLanguage(language));
  }, [language]);

  // The one writer of the module-level mirror in `@/i18n`, so the few callers
  // outside the React tree — `readFunctionError`, which has to turn a server
  // refusal into a sentence — say it in the language on screen.
  useEffect(() => {
    setActiveLanguage(language);
  }, [language]);

  const setLanguage = useCallback(async (value: Language | null) => {
    setStored(value);
    if (value === null) await AsyncStorage.removeItem(KEY).catch(() => undefined);
    else await AsyncStorage.setItem(KEY, value).catch(() => undefined);

    // Persisted natively and read before any JavaScript next time the app
    // opens. Nothing about the current session changes.
    if (Platform.OS !== 'web') {
      const chosen = value ?? deviceLanguage();
      const rtl = isRtlLanguage(chosen);
      I18nManager.allowRTL(rtl);
      I18nManager.forceRTL(rtl);

      // Said at the moment of the choice, and said in a way that has to be
      // dismissed, because the alternative has already failed twice: a banner
      // lives on one screen, and somebody who taps a language and walks away
      // never reads it. The words are in the language just chosen — that is the
      // one they have said they read.
      //
      // Compared against the direction the app *launched* in rather than the
      // language being replaced. Going Arabic → English → Arabic in one sitting
      // ends where it started, and there is nothing left to restart for.
      if (rtl !== LAUNCHED_RTL) {
        const words = STRINGS_BY_LANGUAGE[chosen];

        // Builds carrying `expo-updates` can do it themselves, so they offer
        // rather than instruct. Older binaries — and any build that refuses the
        // reload — still get the sentence that was always true.
        if (canRestart()) {
          Alert.alert(
            words.account.restartTitle,
            rtl ? words.account.restartNowMirror : words.account.restartNowUnmirror,
            [
              { text: words.misc.notNow, style: 'cancel' },
              { text: words.account.restartNow, onPress: () => void restartApp() },
            ],
          );
        } else {
          Alert.alert(
            words.account.restartTitle,
            rtl ? words.signIn.restartToMirror : words.signIn.restartToUnmirror,
            [{ text: words.common.ok }],
          );
        }
      }
    }
  }, []);

  const value = useMemo<LanguageValue>(
    () => ({
      language,
      stored,
      // Following the phone keeps the phone's own tag, which is richer than
      // anything reassembled from a language and a country.
      locale: stored === null ? deviceLocale() : localeFor(stored),
      loading,
      setLanguage,
      phoneLanguage,
      restartNeeded: LAUNCHED_RTL !== null && LAUNCHED_RTL !== isRtlLanguage(language),
    }),
    [language, stored, loading, setLanguage, phoneLanguage],
  );

  return (
    <LanguageContext.Provider value={value}>
      <LanguageValueContext.Provider value={value}>{children}</LanguageValueContext.Provider>
    </LanguageContext.Provider>
  );
}

export function useLanguage(): LanguageValue {
  const value = useContext(LanguageValueContext);
  if (!value) throw new Error('useLanguage must be used inside LanguageProvider');
  return value;
}

function isLanguage(value: string | null): value is Language {
  return value === 'en' || value === 'ta' || value === 'hi' || value === 'ar';
}
