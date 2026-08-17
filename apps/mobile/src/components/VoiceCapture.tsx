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
import { Animated, Easing, Linking, Pressable, View } from 'react-native';

import { iconSize, Text, useTheme, type Theme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { dictationError, speechLocale } from '@/lib/dictation';
import { useMotion } from '@/lib/motion';

const MIC_SIZE = 104;

/**
 * The rings breathing out from the mic while it listens — the near-universal
 * "I am hearing you" of a voice screen (Roku, Meta AI, Todoist). Three staggered
 * pulses expand and fade on a loop, so the surface is visibly live rather than a
 * still button that may or may not be recording. With motion off they do not
 * render at all: the reduced-motion setting is an input, not a hint (TDR §11).
 */
function PulseRings({ active, theme }: { active: boolean; theme: Theme }) {
  const { animated } = useMotion();
  // Held in state (not a ref) so the render below may read them — the values are
  // created once by the lazy initialiser and never replaced, so this never
  // re-renders on its own.
  const [rings] = useState(() => [0, 1, 2].map(() => new Animated.Value(0)));

  useEffect(() => {
    if (!active || !animated) return;
    const loops = rings.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 600),
          Animated.timing(value, {
            toValue: 1,
            duration: 1800,
            easing: Easing.out(Easing.ease),
            useNativeDriver: true,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => {
      loops.forEach((loop) => loop.stop());
      rings.forEach((value) => value.setValue(0));
    };
  }, [active, animated, rings]);

  if (!active || !animated) return null;
  return (
    <>
      {rings.map((value, index) => (
        <Animated.View
          key={index}
          pointerEvents="none"
          style={{
            position: 'absolute',
            width: MIC_SIZE,
            height: MIC_SIZE,
            borderRadius: MIC_SIZE / 2,
            backgroundColor: theme.color.brand,
            opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.28, 0] }),
            transform: [
              { scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 2.4] }) },
            ],
          }}
        />
      ))}
    </>
  );
}

/**
 * A live sound bar under the status while listening — five bars rising and
 * falling out of step, the shorthand for "audio is coming in" (Todoist, Shopee).
 * With motion off it holds a still, uneven silhouette so the shape still reads as
 * a waveform without anything moving.
 */
function Waveform({ active, theme }: { active: boolean; theme: Theme }) {
  const { animated } = useMotion();
  const [bars] = useState(() => [0, 1, 2, 3, 4].map(() => new Animated.Value(0.3)));

  useEffect(() => {
    if (!active || !animated) return;
    const loops = bars.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 120),
          Animated.timing(value, {
            toValue: 1,
            duration: 380,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.timing(value, {
            toValue: 0.3,
            duration: 380,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, animated, bars]);

  // Still but uneven when motion is off — a silhouette, not a flat line.
  const resting = [0.5, 0.9, 0.4, 1, 0.6];
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 5, height: 32 }}>
      {bars.map((value, index) => (
        <Animated.View
          key={index}
          style={{
            width: 4,
            borderRadius: 2,
            backgroundColor: theme.color.brand,
            height: animated
              ? value.interpolate({ inputRange: [0, 1], outputRange: [6, 30] })
              : 6 + resting[index]! * 24,
          }}
        />
      ))}
    </View>
  );
}

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
      {/* The live transcript as it forms, or the prompt before a word is heard —
          the sentence the person is building is the headline of the screen. */}
      <Text variant="title" align="center">
        {live || t.voice.prompt}
      </Text>

      {/* The mic sits inside a fixed square so the pulse rings expanding behind it
          never shove the layout around as they grow. */}
      <View
        style={{
          width: MIC_SIZE * 2.4,
          height: MIC_SIZE * 2.4,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PulseRings active={listening} theme={theme} />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={listening ? t.misc.stopDictating : t.voice.tapToSpeak}
          accessibilityState={{ busy: listening }}
          onPress={() => (listening ? stop() : void start())}
          hitSlop={8}
          style={({ pressed }) => ({
            width: MIC_SIZE,
            height: MIC_SIZE,
            borderRadius: MIC_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: listening ? theme.color.brand : theme.color.brandSoft,
            opacity: pressed ? 0.9 : 1,
          })}
        >
          <Ionicons
            name={listening ? 'stop' : 'mic'}
            size={iconSize.xxl}
            color={listening ? theme.color.onBrand : theme.color.brand}
          />
        </Pressable>
      </View>

      {/* Listening: the status word over a live waveform. Idle: the same status
          line, with a worked example under it so a first-timer knows the shape of
          a sentence the parser understands. */}
      <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <Text tone={listening ? 'brand' : 'muted'}>
          {listening ? t.misc.listening : t.voice.tapToSpeak}
        </Text>
        {listening ? (
          <Waveform active={listening} theme={theme} />
        ) : !live ? (
          <Text variant="caption" tone="faint" align="center">
            {t.voice.example}
          </Text>
        ) : null}
      </View>

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
