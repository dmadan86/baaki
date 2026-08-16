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
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { Linking, Pressable, View } from 'react-native';

import { iconSize, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { dictationError, mergeTranscript, speechLocale } from '@/lib/dictation';

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

/** Whether this phone has a recogniser at all. A phone without one gets no mic. */
function recognitionAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
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

  // What the field held when the mic was tapped. Interim results are re-issued
  // in full, so every one of them is merged onto this rather than onto the
  // field's current contents.
  const before = useRef(value);

  // Leaving the screen while the system permission prompt is open must not let
  // start() touch state or open the mic on an unmounted component.
  const mounted = useRef(true);

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    onChange(mergeTranscript(before.current, transcript));
  });

  useSpeechRecognitionEvent('error', (event) => {
    const message = dictationError(event.error, t.misc.dictationErrors);
    if (message) setError(message);
  });

  useSpeechRecognitionEvent('end', () => setListening(false));

  const stop = useCallback(() => {
    ExpoSpeechRecognitionModule.stop();
    setListening(false);
  }, []);

  const start = useCallback(async () => {
    setError(null);

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!mounted.current) return;
    if (!permission.granted) {
      setError(permission.canAskAgain ? t.misc.micPermission : t.misc.micBlocked);
      return;
    }

    // Best effort, not a requirement: asking for on-device recognition on a
    // phone that has no model for this language would fail outright, and a
    // failed note is worse than a note the OS transcribed over the network.
    let onDevice = false;
    try {
      onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    } catch {
      onDevice = false;
    }

    before.current = value;
    setListening(true);

    try {
      ExpoSpeechRecognitionModule.start({
        lang: speechLocale(language, locale),
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
      setListening(false);
      setError(t.misc.dictationFailed);
    }
  }, [hints, language, locale, value, t]);

  // Leaving the screen mid-sentence must not leave the microphone open.
  useEffect(() => {
    return () => {
      mounted.current = false;
      ExpoSpeechRecognitionModule.abort();
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
