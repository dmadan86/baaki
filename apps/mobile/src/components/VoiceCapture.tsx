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

import { Language, useStrings } from '@/i18n';
import { dictationError, speechLocale } from '@/lib/dictation';

const MIC_SIZE = 104;

/**
 * A soft halo that breathes behind the mic while it listens — a slow, low-opacity
 * swell that makes the button read as a live orb rather than a flat disc. It is
 * the calm base layer under the sharper expanding rings; the two together are the
 * modern voice-assistant look (Siri, Google Assistant).
 */
function Halo({ active, theme }: { active: boolean; theme: Theme }) {
  const [pulse] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!active) return;
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
  }, [active, pulse]);

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
        opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.1, 0.22] }),
        transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 1.12] }) }],
      }}
    />
  );
}

/**
 * The rings breathing out from the mic while it listens — the near-universal
 * "I am hearing you" of a voice screen (Siri, Google Assistant, Meta AI). Three
 * staggered *outline* rings expand and fade on a loop: a thin stroke reads as
 * cleaner and more modern than a filling disc, and layered over the halo it
 * gives the surface real depth rather than a single blunt pulse.
 */
function PulseRings({ active, theme }: { active: boolean; theme: Theme }) {
  // Held in state (not a ref) so the render below may read them — the values are
  // created once by the lazy initialiser and never replaced, so this never
  // re-renders on its own.
  const [rings] = useState(() => [0, 1, 2].map(() => new Animated.Value(0)));

  useEffect(() => {
    if (!active) return;
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
  }, [active, rings]);

  if (!active) return null;
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
 * coming in". Rounded and tinted a touch lighter at the edges for depth.
 */
function Waveform({ active, theme }: { active: boolean; theme: Theme }) {
  const [bars] = useState(() => Array.from({ length: WAVE_BARS }, () => new Animated.Value(0.3)));

  useEffect(() => {
    if (!active) return;
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
  }, [active, bars]);

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
              height: value.interpolate({ inputRange: [0, 1], outputRange: [WAVE_MIN, peak] }),
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
  /**
   * The last utterance was heard but carried no amount — the screen parsed it
   * and came back empty. The panel shows a calm "didn't catch an amount" recovery
   * with the mic as the only way forward, rather than a separate warning and
   * button stacked around it.
   */
  missed?: boolean;
  /**
   * Fired the moment a fresh utterance begins, so the screen can clear a prior
   * `missed`. The mic is the retry: tapping it is what dismisses the miss state.
   */
  onListen?: () => void;
  /**
   * Open the mic on mount. True for the first attempt (the reader tapped a mic to
   * get here, so opening it saves a tap); false when arriving on a miss, where the
   * recovery copy should sit and wait for a deliberate tap rather than reopening
   * the mic under a message the reader has not read yet.
   */
  autoStart?: boolean;
}

function recognitionAvailable(): boolean {
  try {
    return ExpoSpeechRecognitionModule.isRecognitionAvailable();
  } catch {
    return false;
  }
}

/**
 * Whether an on-device English model is actually installed on this phone.
 *
 * `supportsOnDeviceRecognition()` only says the phone can do on-device work at
 * all — not that the model for the language we are about to ask for is present.
 * Requiring on-device for a locale whose model is not downloaded is the quiet
 * failure this screen hit: the recogniser starts, hears the words, and returns
 * nothing, because it was told to use a model that is not there. So on-device is
 * requested only when English is in `installedLocales`; otherwise the mic falls
 * back to network recognition, which speaks English everywhere. (An empty or
 * throwing probe — Android 12 and below, a missing service — resolves to `false`
 * and the network path, which works, rather than the on-device path, which may
 * not.)
 */
async function englishInstalledOnDevice(): Promise<boolean> {
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
    return (installedLocales ?? []).some(
      (tag) => tag.trim().split(/[-_]/)[0]?.toLowerCase() === 'en',
    );
  } catch {
    return false;
  }
}

export function VoiceCapture({
  onDone,
  hints,
  missed,
  onListen,
  autoStart = true,
}: VoiceCaptureProps) {
  const theme = useTheme();
  const { t, locale } = useStrings();

  const [available] = useState(recognitionAvailable);
  const [listening, setListening] = useState(false);
  const [live, setLive] = useState('');
  const [error, setError] = useState<string | null>(null);
  // The mic ran but heard nothing intelligible. Local to the panel — the screen
  // never saw a transcript to parse — and drives the same recovery copy a parsed
  // miss (`missed`) does, so "didn't catch that" and "didn't catch an amount"
  // read as one calm state rather than two different dead ends.
  const [emptyMiss, setEmptyMiss] = useState(false);

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
    // Heard nothing usable — surface the same calm recovery a parsed miss shows,
    // rather than silently dropping back to the opening prompt as if nothing had
    // been tried.
    else setEmptyMiss(true);
  });

  const start = useCallback(async (): Promise<void> => {
    setError(null);
    // Speaking again is the retry: clear both miss states as the mic opens, and
    // let the screen drop any parsed miss it is still holding.
    setEmptyMiss(false);
    onListen?.();
    latest.current = '';
    setLive('');

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!mounted.current) return;
    if (!permission.granted) {
      setError(permission.canAskAgain ? t.misc.micPermission : t.misc.micBlocked);
      return;
    }

    // On-device only when an English model is actually installed; otherwise the
    // recogniser is left to use the network, which speaks English on every phone.
    // Requiring on-device for a model that is not there is what returned silence.
    const onDevice = await englishInstalledOnDevice();
    if (!mounted.current) return;

    setListening(true);
    try {
      ExpoSpeechRecognitionModule.start({
        // Recognition is English-only — the surface each speaker reads is still
        // localised, but the mic listens in English (device region where it can,
        // else en-IN), so there is one locale to get right and no chip to miss.
        lang: speechLocale(Language.En, locale),
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
  }, [hints, locale, onListen, t]);

  const stop = useCallback((): void => {
    ExpoSpeechRecognitionModule.stop();
  }, []);

  // Open the mic as the screen appears — the reader tapped a mic to get here, so
  // making them tap a second one to start would be a step too many. Suppressed
  // when arriving on a miss (`autoStart` false): the recovery copy should be read
  // before the mic reopens, and the mic itself is the retry.
  useEffect(() => {
    if (!available || !autoStart || started.current) return;
    started.current = true;
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [available, autoStart]);

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

  // The recovery state, once, whatever caused it: an utterance that carried no
  // amount (`missed`, parsed by the screen) or one that carried no words at all
  // (`emptyMiss`, seen here). Only while the mic is at rest — a new try clears it.
  const showMiss = !listening && (missed || emptyMiss);
  const missHeadline = missed ? t.voice.noAmount : t.voice.missedNothing;

  return (
    <View style={{ alignItems: 'center', gap: theme.spacing.xl }}>
      {/* One headline, whatever most needs saying: the sentence forming while
          listening, a calm recovery line after a miss, or the opening prompt at
          rest. Never a warning stacked on top of it. */}
      <Text variant="title" align="center">
        {showMiss ? missHeadline : live || t.voice.prompt}
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
          accessibilityLabel={
            listening ? t.misc.stopDictating : showMiss ? t.voice.tapToRetry : t.voice.tapToSpeak
          }
          accessibilityState={{ busy: listening }}
          onPress={() => (listening ? stop() : void start())}
          hitSlop={8}
          style={({ pressed }) => ({
            width: MIC_SIZE,
            height: MIC_SIZE,
            borderRadius: MIC_SIZE / 2,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.buttonPrimary,
            opacity: pressed ? 0.9 : 1,
            // A soft glow lifts the black mic off the surface while it is live.
            ...(listening
              ? {
                  shadowColor: theme.color.buttonPrimary,
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
            color={theme.color.onButtonPrimary}
          />
        </Pressable>
      </View>

      {/* Listening: the status word over a live waveform. Recovering: the mic is
          the retry, so the line invites the tap and a worked example sits under it
          to fix the phrasing. At rest: the same example under a plain prompt. One
          line and one supporting line — never a third. */}
      <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <Text tone={listening || showMiss ? 'brand' : 'muted'}>
          {listening ? t.misc.listening : showMiss ? t.voice.tapToRetry : t.voice.tapToSpeak}
        </Text>
        {listening ? (
          <Waveform active={listening} theme={theme} />
        ) : showMiss ? (
          <Text variant="caption" tone="faint" align="center">
            {t.voice.missHint}
          </Text>
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
