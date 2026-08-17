/**
 * The microphone for the voice quick-add — one spoken sentence, handed back whole.
 *
 * Like `DictateVoice`, recognition is the platform's own and on-device where the
 * phone can manage it, so "add five hundred to the Goa trip" is turned into text
 * on the device, not shipped to a server. It differs in what it is for: not
 * adding to a note, but capturing a single utterance and returning it, so the
 * screen can parse it into an expense.
 *
 * **Nothing imports this file directly** — it is reached through
 * `VoiceMicPanel` inside a `try`, because the `expo-speech-recognition` import
 * throws on any binary built before the native module existed. See the note
 * there.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { ExpoSpeechRecognitionModule, useSpeechRecognitionEvent } from 'expo-speech-recognition';
import { Linking, Pressable, View } from 'react-native';

import { iconSize, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { dictationError, speechLocale } from '@/lib/dictation';

export interface VoiceCaptureProps {
  /** Called with the final sentence once the speaker stops. */
  onDone: (transcript: string) => void;
  /** Names to bias the recogniser towards — group and member names. */
  hints?: readonly string[];
}

function recognitionAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

export function VoiceCapture({ onDone, hints }: VoiceCaptureProps) {
  const theme = useTheme();
  const { t, language, locale } = useStrings();

  const [available] = useState(recognitionAvailable);
  const [listening, setListening] = useState(false);
  const [live, setLive] = useState('');
  const [error, setError] = useState<string | null>(null);

  // The latest transcript, kept in a ref so the 'end' handler reads the final
  // one without waiting on a state update.
  const latest = useRef('');
  const mounted = useRef(true);
  // Guards the one auto-start so a re-render never reopens the mic.
  const started = useRef(false);

  useSpeechRecognitionEvent('result', (event) => {
    const transcript = event.results[0]?.transcript ?? '';
    latest.current = transcript;
    setLive(transcript);
  });

  useSpeechRecognitionEvent('error', (event) => {
    const message = dictationError(event.error, t.misc.dictationErrors);
    if (message) setError(message);
    setListening(false);
  });

  useSpeechRecognitionEvent('end', () => {
    setListening(false);
    const said = latest.current.trim();
    if (said) onDone(said);
  });

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    latest.current = '';
    setLive('');

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!mounted.current) return;
    if (!permission.granted) {
      setError(permission.canAskAgain ? t.misc.micPermission : t.misc.micBlocked);
      return;
    }

    let onDevice = false;
    try {
      onDevice = ExpoSpeechRecognitionModule.supportsOnDeviceRecognition();
    } catch {
      onDevice = false;
    }

    setListening(true);
    try {
      ExpoSpeechRecognitionModule.start({
        lang: speechLocale(language, locale),
        interimResults: true,
        maxAlternatives: 1,
        // One sentence, then it settles — the same shape a note dictation uses.
        continuous: false,
        requiresOnDeviceRecognition: onDevice,
        addsPunctuation: onDevice,
        contextualStrings: hints && hints.length > 0 ? [...hints] : undefined,
        iosTaskHint: 'dictation',
      });
    } catch {
      setListening(false);
      setError(t.misc.dictationFailed);
    }
  }, [hints, language, locale, t]);

  const stop = useCallback((): void => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  // Open the mic as the screen appears — the reader tapped a mic to get here, so
  // making them tap a second one to start would be a step too many.
  useEffect(() => {
    if (!available || started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available]);

  // Leaving mid-sentence must not leave the microphone open.
  useEffect(() => {
    return () => {
      mounted.current = false;
      ExpoSpeechRecognitionModule.abort();
    };
  }, []);

  if (!available) {
    return (
      <Text tone="muted" align="center">
        {t.voice.unavailable}
      </Text>
    );
  }

  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.xl }}>
      <Text variant="title" align="center">
        {live || t.voice.prompt}
      </Text>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? t.misc.stopDictating : t.voice.tapToSpeak}
        accessibilityState={{ busy: listening }}
        onPress={() => (listening ? stop() : void start())}
        hitSlop={8}
        style={({ pressed }) => ({
          width: 96,
          height: 96,
          borderRadius: 48,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: listening ? theme.color.brand : theme.color.brandSoft,
          opacity: pressed ? 0.9 : 1,
        })}
      >
        <Ionicons
          name={listening ? 'stop' : 'mic'}
          size={iconSize.xl}
          color={listening ? theme.color.onBrand : theme.color.brand}
        />
      </Pressable>

      <Text tone={listening ? 'brand' : 'muted'}>
        {listening ? t.misc.listening : t.voice.tapToSpeak}
      </Text>

      {!live && !listening ? (
        <Text variant="caption" tone="faint" align="center">
          {t.voice.example}
        </Text>
      ) : null}

      {error ? (
        <Pressable onPress={() => void Linking.openSettings()} accessibilityRole="button">
          <Text variant="caption" tone="negative" align="center">
            {error}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}
