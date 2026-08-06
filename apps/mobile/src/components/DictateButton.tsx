/**
 * A microphone beside a text field.
 *
 * Speech recognition is the platform's own — `SFSpeechRecognizer` on iOS,
 * `SpeechRecognizer` on Android — and on-device whenever the phone can manage
 * it, so what somebody says at a restaurant table is not shipped to a server to
 * be turned into "Beach shack dinner". Where the phone has no on-device model
 * the OS falls back to its network recogniser, which is the same recogniser the
 * keyboard's own mic key uses.
 *
 * Web renders nothing. Browsers do have a speech API, but it is Google's
 * servers behind it, and this repo uses the web build to check screens rather
 * than to ship them.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { Linking, Platform, Pressable, View } from 'react-native';

import { Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { dictationError, mergeTranscript, speechLocale } from '@/lib/dictation';

export interface DictateButtonProps {
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

const SUPPORTED = Platform.OS === 'ios' || Platform.OS === 'android';

/** Whether this phone has a recogniser at all. A phone without one gets no mic. */
function recognitionAvailable(): boolean {
  if (!SUPPORTED) return false;
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export function DictateButton({ value, onChange, hints }: DictateButtonProps) {
  const theme = useTheme();
  const { language, locale } = useStrings();

  // Asked once, on the first render: this is a property of the phone, not
  // something that changes while somebody is looking at an expense.
  const [available] = useState(recognitionAvailable);
  const [listening, setListening] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // What the field held when the mic was tapped. Interim results are re-issued
  // in full, so every one of them is merged onto this rather than onto the
  // field's current contents.
  const before = useRef(value);

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    onChange(mergeTranscript(before.current, transcript));
  });

  useSpeechRecognitionEvent('error', (event) => {
    const message = dictationError(event.error);
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
    if (!permission.granted) {
      setError(
        permission.canAskAgain
          ? 'Baaki needs permission to use the microphone.'
          : 'Microphone access is off for Baaki. You can turn it on in Settings.',
      );
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
      setError('Dictation could not start. Type the note instead.');
    }
  }, [hints, language, locale, value]);

  // Leaving the screen mid-sentence must not leave the microphone open.
  useEffect(() => {
    return () => {
      if (SUPPORTED) ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  if (!SUPPORTED || !available) return null;

  return (
    <View style={{ alignItems: 'flex-end', gap: theme.spacing.xs }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? 'Stop dictating' : 'Dictate the note'}
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
          size={20}
          color={listening ? theme.color.onBrand : theme.color.brand}
        />
      </Pressable>

      {listening ? (
        <Text variant="micro" tone="brand">
          Listening…
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
