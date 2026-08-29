/**
 * The microphone itself.
 *
 * Speech recognition is the platform's own — `SFSpeechRecognizer` on iOS,
 * `SpeechRecognizer` on Android — and on-device whenever the phone can manage
 * it, so what somebody says at a restaurant table is not shipped to a server to
 * be turned into "Beach shack dinner". Where the phone has no on-device model
 * the OS falls back to its network recogniser, which is the same recogniser the
 * keyboard's own mic key uses.
 *
 * **Nothing imports this file directly.** It is reached through
 * `DictateButton`, which loads it inside a `try`, because the import below
 * throws on any binary built before the native module existed — see the note
 * there.
 *
 * The native recogniser is a single global object with one event stream: every
 * mounted `DictateVoice` (a review screen shows one per expense row) subscribes
 * to the *same* `result`/`error`/`end` events. So a module-level lock hands the
 * mic to one field at a time, and each instance acts on an event only while it
 * is the one listening — otherwise idle rows cross-write the transcript, and a
 * row unmounting (the list changing after "add more") aborts a capture some
 * other surface just started.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { Linking, Pressable, View } from 'react-native';

import { iconSize, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import {
  dictationError,
  mergeTranscript,
  onDeviceLocaleInstalled,
  speechLocale,
} from '@/lib/dictation';

export interface DictateProps {
  /** What is in the field now. Dictation adds to it, never replaces it. */
  value: string;
  onChange: (next: string) => void;
  /**
   * Words the recogniser should expect — member names, usually. Indian names
   * are exactly what a general model gets wrong, and this is the one lever the
   * platform gives us over that.
   */
  hints?: readonly string[];
}

/**
 * Which field currently owns the single native recogniser, or `null` when no
 * dictation is running. Module-level on purpose: it is shared across every
 * mounted `DictateVoice` so a second field cannot start a capture on top of the
 * first, and so only the owning field reacts to the global events.
 */
let micOwner: symbol | null = null;

/** Whether this phone has a recogniser at all. A phone without one gets no mic. */
function recognitionAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/**
 * Languages already confirmed on-device this session — kept so a flaky re-probe
 * cannot downgrade one to the network path.
 *
 * `getSupportedLocales` is unreliable when called right after a recognition
 * session ends: Android's RecognitionService is briefly busy and the query
 * throws or returns empty, so the `catch` reports `false`. That flipped a second
 * dictation to the network recogniser — which, offline, fails with a "needs a
 * connection" error even though the model that served the first is still there.
 * A model is not uninstalled between two utterances, so the positive signal is
 * reliable and a re-probe's negative is not: latch each confirmed tag.
 */
const onDeviceConfirmed = new Set<string>();

/**
 * Whether an on-device model for `langTag` is actually installed on this phone.
 *
 * `supportsOnDeviceRecognition()` only says the phone can do on-device work at
 * all — not that the model for the language we are about to ask for is present.
 * Requiring on-device for a locale whose model is not downloaded is a quiet
 * failure: the recogniser starts, hears the words, and returns nothing, because
 * it was told to use a model that is not there (the "did not catch anything"
 * this field used to hit). So on-device is requested only when this language is
 * in `installedLocales`; otherwise the mic falls back to network recognition,
 * which is what the keyboard's mic key uses. An empty or throwing probe
 * (Android 12 and below, a missing service) resolves to `false` and the network
 * path, which works, rather than the on-device path, which may not.
 */
async function installedOnDeviceFor(langTag: string): Promise<boolean> {
  if (onDeviceConfirmed.has(langTag)) return true;
  try {
    let supportsOnDevice = false;
    try {
      supportsOnDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    } catch {
      supportsOnDevice = false;
    }
    if (!supportsOnDevice) return false;

    let androidRecognitionServicePackage: string | undefined;
    try {
      const pkg = ExpoSpeechRecognitionModule.getDefaultRecognitionService?.().packageName;
      if (pkg) androidRecognitionServicePackage = pkg;
    } catch {
      // iOS / older builds have no Android service concept — query without one.
    }
    const { installedLocales } = await ExpoSpeechRecognitionModule.getSupportedLocales(
      androidRecognitionServicePackage ? { androidRecognitionServicePackage } : {},
    );
    // Match the whole tag, region and all: a phone with only en-US installed
    // must not be told it has the en-IN model (that returns silence).
    const installed = onDeviceLocaleInstalled(langTag, installedLocales);
    if (installed) onDeviceConfirmed.add(langTag);
    return installed;
  } catch {
    return false;
  }
}

export function DictateVoice({ value, onChange, hints }: DictateProps) {
  const theme = useTheme();
  const { t, language, locale } = useStrings();

  // Asked once, on the first render: this is a property of the phone, not
  // something that changes while somebody is looking at an expense.
  const [available] = useState(recognitionAvailable);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // This instance's identity in the module-level `micOwner` lock. Stable for the
  // life of the component (lazy-initialised so it is minted once).
  const [id] = useState(() => Symbol('dictate'));

  // Whether *this* field is the one currently listening, read synchronously
  // inside the global event handlers. The single-owner lock guarantees at most
  // one field has this set at a time, so it is a safe stand-in for "this event
  // is mine" — and it avoids reacting to an event another field's session fired.
  const listeningRef = useRef(false);
  const setListeningState = useCallback((next: boolean): void => {
    listeningRef.current = next;
    setListening(next);
  }, []);

  // What the field held when the mic was tapped. Interim results are re-issued
  // in full, so every one of them is merged onto this rather than onto the
  // field's current contents.
  const before = useRef(value);

  // Leaving the screen while the system permission prompt is open must not let
  // start() touch state or open the mic on an unmounted component.
  const mounted = useRef(true);

  useSpeechRecognitionEvent('result', (event) => {
    // Only the field that started this capture takes the words — otherwise the
    // other rows' mics would each merge the transcript into their own note too.
    if (!listeningRef.current) return;
    const transcript = event.results[0]?.transcript ?? '';
    onChange(mergeTranscript(before.current, transcript));
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!listeningRef.current) return;
    micOwner = null;
    setListeningState(false);
    const message = dictationError(event.error, t.misc.dictationErrors);
    if (message) setError(message);
  });

  useSpeechRecognitionEvent('end', () => {
    if (!listeningRef.current) return;
    micOwner = null;
    setListeningState(false);
  });

  const stop = useCallback(() => {
    // Ask the recogniser to finish — but hold the lock and the listening flag.
    // stop() (unlike abort()) still delivers one last `result` and then `end`,
    // and it is the `end`/`error` handlers that clear ownership. Clearing it
    // here would make that final result's `if (!listeningRef.current) return`
    // drop the last words the person spoke before tapping stop.
    ExpoSpeechRecognitionModule.stop();
  }, []);

  const start = useCallback(async () => {
    // The mic is a single global object. If another field is mid-dictation,
    // ignore the tap rather than aborting it: an abort would race that field's
    // next event and wedge the recogniser for both.
    if (micOwner !== null && micOwner !== id) return;

    setError(null);

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!mounted.current) return;
    if (!permission.granted) {
      setError(permission.canAskAgain ? t.misc.micPermission : t.misc.micBlocked);
      return;
    }

    const lang = speechLocale(language, locale);

    // Best effort, not a requirement: asking for on-device recognition on a
    // phone that has no model for this language returns silence, so fall to the
    // network recogniser unless the language's model is actually installed.
    const onDevice = await installedOnDeviceFor(lang);
    if (!mounted.current) return;

    // Re-check the lock right before taking it. The two awaits above (the
    // permission prompt, the installed-model probe) give another field a window
    // to claim the mic between the first check and here; without this recheck
    // two overlapping starts could both reach ExpoSpeechRecognitionModule.start.
    if (micOwner !== null && micOwner !== id) return;

    before.current = value;
    micOwner = id;
    setListeningState(true);

    try {
      ExpoSpeechRecognitionModule.start({
        lang,
        interimResults: true,
        maxAlternatives: 1,
        // A note is one short utterance. Continuous listening would leave the
        // mic open on a table full of other people talking.
        continuous: false,
        requiresOnDeviceRecognition: onDevice,
        // Android only honours this with on-device recognition; iOS punctuates
        // either way.
        addsPunctuation: onDevice,
        contextualStrings: hints && hints.length > 0 ? [...hints] : undefined,
        iosTaskHint: 'dictation',
      });
    } catch {
      micOwner = null;
      setListeningState(false);
      setError(t.misc.dictationFailed);
    }
  }, [hints, id, language, locale, value, t, setListeningState]);

  // Leaving the screen mid-sentence must not leave the microphone open — but
  // only this field may abort, and only while it is the one listening. An idle
  // row unmounting (the list changing after "add more") must not abort a capture
  // another surface just started.
  useEffect(() => {
    return () => {
      mounted.current = false;
      if (listeningRef.current) {
        try {
          ExpoSpeechRecognitionModule.abort();
        } catch {
          // Recogniser already torn down — nothing to abort.
        }
        micOwner = null;
      }
    };
  }, []);

  if (!available) return null;

  return (
    <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? t.misc.stopDictating : t.misc.dictateNote}
        accessibilityState={{ busy: listening }}
        onPress={() => (listening ? stop() : void start())}
        hitSlop={8}
        style={({ pressed }) => ({
          width: 44,
          height: 44,
          borderRadius: theme.radius.pill,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: listening ? theme.color.brand : theme.color.brandSoft,
          opacity: pressed ? 0.85 : 1,
        })}
      >
        <Ionicons
          name={listening ? 'stop' : 'mic-outline'}
          size={iconSize.lg}
          color={listening ? theme.color.onBrand : theme.color.brand}
        />
      </Pressable>

      {listening ? (
        <Text variant="micro" tone="brand">
          {t.misc.listening}
        </Text>
      ) : null}

      {error ? (
        <Pressable onPress={() => void Linking.openSettings()} accessibilityRole="button">
          <Text variant="micro" tone="negative" style={{ textAlign: 'right' }}>
            {error}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
