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

import { iconSize, Text, useTheme, type Theme } from '@waves/ui';

import { LANGUAGES, LANGUAGE_NAMES, useStrings, type Language } from '@/i18n';
import { dictationError, speechLocale } from '@/lib/dictation';
import { useMotion } from '@/lib/motion';

const MIC_SIZE = 104;

/**
 * A soft halo that breathes behind the mic while it listens — a slow, low-opacity
 * swell that makes the button read as a live orb rather than a flat disc. It is
 * the calm base layer under the sharper expanding rings; the two together are the
 * modern voice-assistant look (Siri, Google Assistant). With motion off it holds
 * a single gentle glow so the depth is still there without anything moving.
 */
function Halo({ active, theme }: { active: boolean; theme: Theme }) {
  const { animated } = useMotion();
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!active || !animated) return;
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, {
          toValue: 1,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
        Animated.timing(pulse, {
          toValue: 0,
          duration: 1600,
          easing: Easing.inOut(Easing.ease),
          useNativeDriver: true,
        }),
      ]),
    );
    loop.start();
    return () => {
      loop.stop();
      pulse.setValue(0);
    };
  }, [active, animated, pulse]);

  if (!active) return null;
  const size = MIC_SIZE * 1.7;
  return (
    <Animated.View
      pointerEvents="none"
      style={{
        position: 'absolute',
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: theme.color.brand,
        opacity: animated
          ? pulse.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.22] })
          : 0.14,
        transform: [
          {
            scale: animated
              ? pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] })
              : 1.05,
          },
        ],
      }}
    />
  );
}

/**
 * The rings breathing out from the mic while it listens — the near-universal
 * "I am hearing you" of a voice screen (Siri, Google Assistant, Meta AI). Three
 * staggered *outline* rings expand and fade on a loop: a thin stroke reads as
 * cleaner and more modern than a filling disc, and layered over the halo it
 * gives the surface real depth rather than a single blunt pulse. With motion off
 * they do not render at all — the reduced-motion setting is an input, not a hint
 * (TDR §11); the still halo alone carries the idle state.
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
          Animated.delay(index * 700),
          Animated.timing(value, {
            toValue: 1,
            duration: 2100,
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
            borderWidth: 2,
            borderColor: theme.color.brand,
            opacity: value.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
            transform: [
              { scale: value.interpolate({ inputRange: [0, 1], outputRange: [1, 2.6] }) },
            ],
          }}
        />
      ))}
    </>
  );
}

/** How many bars in the waveform, and the tallest each may reach. */
const WAVE_BARS = 9;
const WAVE_MIN = 6;

/**
 * The peak height a bar may reach, weighted toward the centre so the row reads as
 * a rounded wave crest rather than a flat block — the centre bars tower, the
 * edges stay short (the equaliser shape every voice UI settled on).
 */
function barPeak(index: number): number {
  const middle = (WAVE_BARS - 1) / 2;
  const distance = Math.abs(index - middle) / middle;
  return 34 - distance * 18;
}

/**
 * A live sound wave under the status while listening — nine bars rising and
 * falling out of step, centre-weighted into a crest, the shorthand for "audio is
 * coming in". Rounded and tinted a touch lighter at the edges for depth. With
 * motion off it holds a still crest silhouette so the shape still reads as a
 * waveform without anything moving.
 */
function Waveform({ active, theme }: { active: boolean; theme: Theme }) {
  const { animated } = useMotion();
  const [bars] = useState(() => Array.from({ length: WAVE_BARS }, () => new Animated.Value(0.3)));

  useEffect(() => {
    if (!active || !animated) return;
    const loops = bars.map((value, index) =>
      Animated.loop(
        Animated.sequence([
          Animated.delay(index * 70),
          Animated.timing(value, {
            toValue: 1,
            duration: 300 + (index % 3) * 60,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
          Animated.timing(value, {
            toValue: 0.28,
            duration: 300 + (index % 3) * 60,
            easing: Easing.inOut(Easing.ease),
            useNativeDriver: false,
          }),
        ]),
      ),
    );
    loops.forEach((loop) => loop.start());
    return () => loops.forEach((loop) => loop.stop());
  }, [active, animated, bars]);

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4, height: 36 }}>
      {bars.map((value, index) => {
        const peak = barPeak(index);
        // Edge bars a touch translucent so the crest has depth, not a flat wall.
        const middle = (WAVE_BARS - 1) / 2;
        const opacity = 1 - (Math.abs(index - middle) / middle) * 0.35;
        return (
          <Animated.View
            key={index}
            style={{
              width: 4,
              borderRadius: 2,
              backgroundColor: theme.color.brand,
              opacity,
              height: animated
                ? value.interpolate({ inputRange: [0, 1], outputRange: [WAVE_MIN, peak] })
                : (WAVE_MIN + peak) / 2,
            }}
          />
        );
      })}
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
  // Which language the recogniser listens in this session. Defaults to the app
  // language, but a speaker whose phone is in one language and mouth in another
  // can switch it here without changing the whole app — on-device recognition
  // targets one locale per session, so this is a per-utterance choice.
  const [spokenLang, setSpokenLang] = useState<Language | null>(null);
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

  const start = useCallback(
    async (langOverride?: Language): Promise<void> => {
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
          // The explicit override (a language just tapped) wins over the session
          // choice, which wins over the app language — the tap must take effect
          // now, before its `setState` has landed.
          lang: speechLocale(langOverride ?? spokenLang ?? language, locale),
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
    },
    [hints, spokenLang, language, locale, t],
  );

  // Pick the language to listen in. If the mic is already open, restart it at
  // once in the new language; otherwise the choice applies on the next tap.
  const chooseLang = useCallback(
    (lang: Language): void => {
      setSpokenLang(lang);
      if (listening) {
        ExpoSpeechRecognitionModule.abort();
        void start(lang);
      }
    },
    [listening, start],
  );

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
        <Halo active={listening} theme={theme} />
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
            // A brand-tinted glow lifts the mic off the surface while it is live.
            ...(listening
              ? {
                  shadowColor: theme.color.brand,
                  shadowOpacity: 0.45,
                  shadowRadius: 20,
                  shadowOffset: { width: 0, height: 6 },
                  elevation: 10,
                }
              : null),
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

      {/* Which language to listen in — the recogniser targets one locale per
          session, so a speaker whose phone is in one language and mouth in
          another picks it here. The chip shows each language in its own script,
          so it is found by the name its speaker knows. */}
      <View
        style={{
          flexDirection: 'row',
          flexWrap: 'wrap',
          justifyContent: 'center',
          alignItems: 'center',
          gap: theme.spacing.sm,
        }}
      >
        <Ionicons name="globe-outline" size={iconSize.sm} color={theme.color.textMuted} />
        {LANGUAGES.map((lang) => {
          const selected = (spokenLang ?? language) === lang;
          return (
            <Pressable
              key={lang}
              onPress={() => chooseLang(lang)}
              accessibilityRole="button"
              accessibilityState={{ selected }}
              accessibilityLabel={LANGUAGE_NAMES[lang].english}
              style={({ pressed }) => ({
                paddingVertical: theme.spacing.xs,
                paddingHorizontal: theme.spacing.md,
                borderRadius: theme.radius.pill,
                backgroundColor: selected ? theme.color.brandSoft : theme.color.surfaceMuted,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text
                variant="caption"
                style={{
                  color: selected ? theme.color.brand : theme.color.textMuted,
                  fontWeight: selected ? '600' : '400',
                }}
              >
                {LANGUAGE_NAMES[lang].own}
              </Text>
            </Pressable>
          );
        })}
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
