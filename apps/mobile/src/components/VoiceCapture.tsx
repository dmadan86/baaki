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
import Reanimated, {
  cancelAnimation,
  Easing as ReEasing,
  useAnimatedProps,
  useSharedValue,
  withRepeat,
  withTiming,
  type SharedValue,
} from 'react-native-reanimated';
import Svg, { Defs, LinearGradient, Path, Stop } from 'react-native-svg';

import { iconSize, Text, useTheme, type Theme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { dictationError, englishSpeechLocale } from '@/lib/dictation';
import { useReducedMotion } from '@/lib/reducedMotion';
import { speechMic } from '@/lib/speechMic';

const MIC_SIZE = 104;

// Hand the shared arbiter the real recogniser. Safe at module scope: this file
// is only ever loaded through `VoiceMicPanel`'s guarded require, so reaching it
// at all means the native module imported cleanly.
speechMic.attach({
  stop: () => ExpoSpeechRecognitionModule.stop(),
  abort: () => ExpoSpeechRecognitionModule.abort(),
});

/**
 * How long a session may stay completely inert before it is written off.
 *
 * A live recogniser says so within a beat — `start` (ready for speech) lands
 * well under a second, and `volumechange` follows it continuously. A session
 * that has produced *nothing at all* after this long is not listening: its
 * recogniser was destroyed under it, which the platform reports by saying
 * nothing whatsoever. Generous on purpose, because the only cost of waiting is
 * a slower error and the cost of firing early is cutting somebody off.
 */
const STALL_MS = 8000;

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

/** The waveform's drawing box. Fixed and centred — the status area centres it. */
const WAVE_W = 300;
const WAVE_H = 104;

/**
 * The listening wave: filled, symmetric lobes mirrored about the centre line, the
 * shape a modern voice assistant draws while it hears you. Each layer is a closed
 * ribbon that swells into humps and pinches to a hairline between them, tapering
 * to a fine point at both ends; layered and blended over one pink→cyan gradient,
 * the overlaps build a bright core with crisp edges. Layers differ in wavelength
 * (`cycles`), phase, height (`amp`) and opacity so the humps sit in different
 * places and the wave reads as one living body, not a stack of copies. The last
 * layer is the hot white core.
 */
const WAVE_GRADIENT = 'url(#ecoWaveGrad)';

const WAVE_LAYERS = [
  { id: 'l0', fill: WAVE_GRADIENT, cycles: 1.1, phase: 0.0, amp: 0.62, opacity: 0.42 },
  { id: 'l1', fill: WAVE_GRADIENT, cycles: 1.7, phase: 0.9, amp: 0.82, opacity: 0.4 },
  { id: 'l2', fill: WAVE_GRADIENT, cycles: 1.0, phase: 1.9, amp: 1.0, opacity: 0.4 },
  { id: 'l3', fill: WAVE_GRADIENT, cycles: 2.1, phase: 2.7, amp: 0.72, opacity: 0.4 },
  { id: 'l4', fill: WAVE_GRADIENT, cycles: 1.5, phase: 3.6, amp: 0.9, opacity: 0.42 },
  // The hot core: a bright, low, tight ribbon on top, where a real voice UI's
  // centre burns near white.
  { id: 'core', fill: '#F0F9FF', cycles: 1.5, phase: 1.2, amp: 0.34, opacity: 0.9 },
] as const;

type WaveLayerSpec = (typeof WAVE_LAYERS)[number];

const AnimatedPath = Reanimated.createAnimatedComponent(Path);

/**
 * One layer's closed path for the current phase: the top edge left→right, then the
 * mirrored bottom edge right→left, closed into a filled ribbon. Symmetric about
 * the centre line, so it swells into centre-weighted humps and pinches to a
 * hairline between them, tapering to a point at both ends like the reference.
 * Runs on the UI thread — the body of a `useAnimatedProps` worklet.
 */
function wavePath(phase: number, level: number, layer: WaveLayerSpec): string {
  'worklet';
  const points = 72;
  const cy = WAVE_H / 2;
  const breath = 0.85 + 0.15 * Math.sin(phase * 2 + layer.phase);
  // Loudness drives the height: a quiet mic keeps a low idling ribbon (40%), a
  // loud voice pushes it to full. `level` is the eased 0…1 metering; when the
  // platform sends no volume events it stays 0 and the wave simply idles.
  const loud = 0.4 + 0.6 * level;
  const reach = (WAVE_H / 2 - 1) * layer.amp * breath * loud;
  let top = '';
  let bottom = '';
  for (let i = 0; i <= points; i++) {
    const frac = i / points;
    const x = (frac * WAVE_W).toFixed(2);
    const env = Math.exp(-Math.pow((frac - 0.5) / 0.34, 2));
    const hump = Math.abs(Math.sin(frac * layer.cycles * Math.PI * 2 + phase + layer.phase));
    // 0.05 keeps a hairline through the middle so the lobes read as one wave, not
    // a row of separate blobs; the rest is the swelling hump.
    const h = env * reach * (0.05 + 0.95 * hump);
    top += `${i === 0 ? 'M' : 'L'}${x} ${(cy - h).toFixed(2)} `;
    // Prepend the bottom edge so it reads right→left once appended after the top.
    bottom = `L${x} ${(cy + h).toFixed(2)} ${bottom}`;
  }
  return `${top}${bottom}Z`;
}

/** One translucent filled ribbon, its path recomputed each frame from `phase`
 *  and the live loudness `level`. */
function WaveLayer({
  phase,
  level,
  layer,
}: {
  phase: SharedValue<number>;
  level: SharedValue<number>;
  layer: WaveLayerSpec;
}) {
  const animatedProps = useAnimatedProps(() => ({ d: wavePath(phase.value, level.value, layer) }));
  return <AnimatedPath animatedProps={animatedProps} fill={layer.fill} opacity={layer.opacity} />;
}

/**
 * The live sound wave under the status while listening — filled, symmetric colour
 * lobes swelling and pinching across a bright core, the "I am hearing you" of a
 * modern voice screen. One shared phase drives every layer on the UI thread; the
 * layers differ in wavelength and phase so their humps sit in different places and
 * the wave reads as one living body. Only mounted while listening, so the loop is
 * torn down the moment it stops.
 */
function Waveform({ active, level }: { active: boolean; level: SharedValue<number> }) {
  const phase = useSharedValue(0);

  useEffect(() => {
    if (!active) return;
    phase.value = 0;
    // 0 → 2π on a loop. Both the hump term (|sin|, period π) and the breath
    // (sin of 2·phase) are seamless across the seam.
    phase.value = withRepeat(
      withTiming(Math.PI * 2, { duration: 2400, easing: ReEasing.linear }),
      -1,
      false,
    );
    return () => cancelAnimation(phase);
  }, [active, phase]);

  return (
    <Svg width={WAVE_W} height={WAVE_H}>
      <Defs>
        {/* Pink → fuchsia → violet → blue → cyan, left to right, so the whole
            wave carries the reference's horizontal hue shift no matter which
            layer a given lobe belongs to. */}
        <LinearGradient id="ecoWaveGrad" x1="0" y1="0" x2="1" y2="0">
          <Stop offset="0" stopColor="#F472B6" />
          <Stop offset="0.28" stopColor="#C084FC" />
          <Stop offset="0.52" stopColor="#818CF8" />
          <Stop offset="0.74" stopColor="#38BDF8" />
          <Stop offset="1" stopColor="#22D3EE" />
        </LinearGradient>
      </Defs>
      {WAVE_LAYERS.map((layer) => (
        <WaveLayer key={layer.id} phase={phase} level={level} layer={layer} />
      ))}
    </Svg>
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
 * Once English has been confirmed on-device, keep that answer for the session.
 *
 * The probe below (`getSupportedLocales`) is flaky when called right after a
 * recognition session ends: Android's RecognitionService is briefly busy and the
 * query throws or returns empty, so the `catch` reports `false`. That flipped the
 * *second* capture to the network recogniser — which, offline, fails with a
 * "needs a connection" error even though the very model that served the first
 * capture is still installed. A model is not uninstalled between two utterances,
 * so the positive signal is reliable and a re-probe's negative is not: latch the
 * true and never re-probe once it lands.
 */
let englishOnDeviceConfirmed = false;

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
  if (englishOnDeviceConfirmed) return true;
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
    const installed = (installedLocales ?? []).some(
      (tag) => tag.trim().split(/[-_]/)[0]?.toLowerCase() === 'en',
    );
    if (installed) englishOnDeviceConfirmed = true;
    return installed;
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
  const reduceMotion = useReducedMotion();
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

  // Live input loudness, 0…1, eased from the recogniser's volume events. The
  // waveform rides this so it answers the actual voice instead of looping on a
  // fixed clock; it stays 0 when the mic is shut.
  const level = useSharedValue(0);

  // The latest transcript, kept in a ref so the 'end' handler reads the final
  // one without waiting on a state update.
  const latest = useRef('');
  const mounted = useRef(true);
  // Guards the one auto-start so a re-render never reopens the mic.
  const started = useRef(false);

  // This instance's claim on the single recogniser (see lib/speechMic). Minted
  // once per mount, and the answer to "is this event mine?" — the events are
  // global, so a panel that does not hold the mic must ignore every one of them.
  // In particular the `end` a *previous* panel's abort still owes belongs to
  // nobody, and closing this capture on it is what left the second attempt dead.
  const [session] = useState(() => Symbol('voice-capture'));

  // A start is already on its way — the mic is claimed but the native call has
  // not been made yet, because a permission check and an installed-model probe
  // are awaited first. Two taps inside that window would otherwise both see an
  // idle mic and issue two native starts, the second destroying the first.
  const starting = useRef(false);

  // Nothing at all has come back from this session yet. Armed when the native
  // start is issued, disarmed by the first event of any kind; if it fires, the
  // recogniser never woke up and the panel says so instead of sitting on
  // "listening" forever.
  const stall = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearStall = useCallback((): void => {
    if (stall.current === null) return;
    clearTimeout(stall.current);
    stall.current = null;
  }, []);

  useSpeechRecognitionEvent('start', () => {
    if (!speechMic.owns(session)) return;
    clearStall();
  });

  useSpeechRecognitionEvent('result', (event) => {
    if (!speechMic.owns(session)) return;
    clearStall();
    const transcript = event.results[0]?.transcript ?? '';
    latest.current = transcript;
    setLive(transcript);
  });

  // The recogniser's own metering (enabled via volumeChangeEventOptions in
  // start). `value` runs −2…10, where below 0 is inaudible; normalise to 0…1 and
  // ease so the wave tracks loudness without twitching on every packet.
  useSpeechRecognitionEvent('volumechange', (event) => {
    if (!speechMic.owns(session)) return;
    clearStall();
    const norm = Math.max(0, Math.min(1, event.value / 10));
    // `.set()`, not `.value =`: Reanimated 4's method API, the one the React
    // compiler allows off the UI thread (see PressableScale in lib/anim).
    level.set(withTiming(norm, { duration: 90 }));
  });

  useSpeechRecognitionEvent('error', (event) => {
    if (!speechMic.owns(session)) return;
    clearStall();
    const message = dictationError(event.error, t.misc.dictationErrors);
    if (message) setError(message);
    setListening(false);
    level.set(withTiming(0, { duration: 150 }));
    // Ownership is held for the `end` that follows, so it is still recognised as
    // this session's; the arbiter arms its own guard in case that `end` never
    // comes.
    speechMic.errored(session);
  });

  useSpeechRecognitionEvent('end', () => {
    // Told either way: the recogniser really has finished, and the next capture
    // is waiting on exactly this to know it may open. The answer decides whether
    // the ending was *this* capture's — which is not the same as owning the mic
    // right now. A previous session's teardown can report in late, after the
    // guard timer settled it and this panel opened; the arbiter swallows it, and
    // this panel must not act on it either, or it closes a capture that has
    // barely started.
    if (!speechMic.ended(session)) return;
    clearStall();
    setListening(false);
    level.set(withTiming(0, { duration: 150 }));
    const said = latest.current.trim();
    if (said) onDone(said);
    // Heard nothing usable — surface the same calm recovery a parsed miss shows,
    // rather than silently dropping back to the opening prompt as if nothing had
    // been tried.
    else setEmptyMiss(true);
  });

  const start = useCallback(async (): Promise<void> => {
    // One start at a time from this panel, and one capture at a time in the app.
    if (starting.current) return;
    starting.current = true;
    // Still holding the mic from a session the panel has already given up on —
    // an error whose `end` never arrived, say. The tap is a deliberate retry, so
    // let go of the old session here; the claim below then waits for its
    // teardown rather than opening a second recogniser on top of it.
    if (speechMic.owns(session)) speechMic.release(session);
    setError(null);
    // Speaking again is the retry: clear both miss states as the mic opens, and
    // let the screen drop any parsed miss it is still holding.
    setEmptyMiss(false);
    onListen?.();
    latest.current = '';
    setLive('');
    level.set(0);

    // Claim the recogniser first, and wait here for any previous session's
    // teardown to land. Everything below must give it back — a claimed mic that
    // is never released is one nothing can reopen.
    const claimed = await speechMic.acquire(session);
    if (!mounted.current) {
      starting.current = false;
      if (claimed) speechMic.release(session);
      return;
    }
    if (!claimed) {
      starting.current = false;
      setError(t.misc.dictationFailed);
      return;
    }

    const give = (): void => {
      starting.current = false;
      speechMic.release(session);
    };

    const permission = await ExpoSpeechRecognitionModule.requestPermissionsAsync();
    if (!mounted.current) return give();
    if (!permission.granted) {
      setError(permission.canAskAgain ? t.misc.micPermission : t.misc.micBlocked);
      return give();
    }

    // On-device only when an English model is actually installed; otherwise the
    // recogniser is left to use the network, which speaks English on every phone.
    // Requiring on-device for a model that is not there is what returned silence.
    const onDevice = await englishInstalledOnDevice();
    if (!mounted.current) return give();

    setListening(true);
    try {
      ExpoSpeechRecognitionModule.start({
        // Recognition is English-only — the surface each speaker reads is still
        // localised, but the mic listens in English (device region where it can,
        // else en-IN), so there is one locale to get right and no chip to miss.
        lang: englishSpeechLocale(locale),
        interimResults: true,
        maxAlternatives: 1,
        // One sentence, then it settles — the same shape a note dictation uses.
        continuous: false,
        requiresOnDeviceRecognition: onDevice,
        addsPunctuation: onDevice,
        // Meter the input so the waveform can ride real loudness (~10 Hz is
        // plenty for a smooth wave and cheap to ease over).
        volumeChangeEventOptions: { enabled: true, intervalMillis: 100 },
        contextualStrings: hints && hints.length > 0 ? [...hints] : undefined,
        iosTaskHint: 'dictation',
        // People start with a greeting and a beat of thought — "hello… uh… add
        // 500 to Goa". Android's default endpointing finalises on that first
        // pause, ending the session on the greeting alone. Give it room: keep
        // listening for at least a few seconds, and do not treat a two-second
        // pause as the end of speech. (Android-only extras; iOS endpointing is
        // already more forgiving and ignores these.)
        androidIntentOptions: {
          EXTRA_SPEECH_INPUT_MINIMUM_LENGTH_MILLIS: 4000,
          EXTRA_SPEECH_INPUT_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
          EXTRA_SPEECH_INPUT_POSSIBLY_COMPLETE_SILENCE_LENGTH_MILLIS: 2000,
        },
      });
      speechMic.opened(session);
      starting.current = false;
      // Nothing has come back yet; if nothing ever does, the recogniser was
      // torn down under us and the panel must say so rather than pretend.
      clearStall();
      stall.current = setTimeout(() => {
        stall.current = null;
        if (!mounted.current || !speechMic.owns(session)) return;
        setListening(false);
        level.set(withTiming(0, { duration: 150 }));
        setError(t.misc.dictationFailed);
        speechMic.release(session);
      }, STALL_MS);
    } catch {
      setListening(false);
      setError(t.misc.dictationFailed);
      give();
    }
  }, [clearStall, hints, level, locale, onListen, session, t]);

  const stop = useCallback((): void => {
    // Ask the recogniser to finish, but keep the session: `stop()` (unlike
    // `abort()`) still delivers one last `result`, and giving the mic up here
    // would make the handler above drop the words spoken before the tap.
    speechMic.stop(session);
  }, [session]);

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

  // Leaving mid-sentence must not leave the microphone open, and must not leave
  // it claimed either: the panel is remounted (via a changing `key`) to start
  // each new capture, and a claim nobody gives back is a mic the next mount can
  // never open. `release` is the one call for both — it aborts a live session
  // and simply hands back a claim that never got as far as the native start.
  //
  // `mounted` is re-armed on the way in, not just cleared on the way out: this
  // effect is re-run whole by a Fast Refresh, and a flag that only ever goes
  // false would leave every later `start()` bailing out after its first await.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      clearStall();
      starting.current = false;
      speechMic.release(session);
    };
  }, [clearStall, session]);

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
        <Halo active={listening && !reduceMotion} theme={theme} />
        <PulseRings active={listening && !reduceMotion} theme={theme} />
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

      {/* Listening: the status word over a live waveform. Recovering: the title
          already says what was missed, so the mic just invites the tap — no
          second warning under it. At rest: a worked example under the prompt.
          The miss is stated once (the title), never a warning stacked on a
          warning. */}
      <View style={{ alignItems: 'center', gap: theme.spacing.md }}>
        <Text tone={listening || showMiss ? 'brand' : 'muted'}>
          {listening ? t.misc.listening : showMiss ? t.voice.tapToRetry : t.voice.tapToSpeak}
        </Text>
        {listening && !reduceMotion ? (
          <Waveform active={listening} level={level} />
        ) : !listening && !showMiss && !live ? (
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
