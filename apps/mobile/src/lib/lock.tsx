import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { useFocusEffect } from 'expo-router';
import { AppState, Platform } from 'react-native';

import { plural, type UiStrings } from '@/i18n';
import { legacyKeysMigrated } from '@/lib/legacyKeys';

const KEY = 'waves.app_lock_enabled';
const GRACE_KEY = 'waves.app_lock_grace_seconds';

/**
 * How long the app may stay open after being backgrounded before it asks again.
 *
 * A lock that re-authenticates the instant you glance at a notification is a
 * lock people turn off, and one that never re-authenticates is decoration. The
 * default is thirty seconds: long enough to be sent to a UPI app and come back,
 * short enough that a phone left on a table is not an open ledger.
 */
export const GRACE_CHOICES = [0, 15, 30, 60, 300] as const;
export const DEFAULT_GRACE_SECONDS = 30;

interface LockValue {
  /** Whether the user has turned the lock on. */
  enabled: boolean;
  /** Whether the app is currently waiting to be unlocked. */
  locked: boolean;
  supported: boolean;
  /**
   * False until the stored state and the hardware check have both come back.
   * Whether a device can lock is read asynchronously, and `supported` starts
   * false, so a row rendered before this is true would say 'not available' on a
   * phone that supports it perfectly well — the worst possible flicker on a
   * security setting.
   */
  ready: boolean;
  /** Seconds in the background before the lock comes back. */
  graceSeconds: number;
  setEnabled: (value: boolean) => Promise<void>;
  setGraceSeconds: (value: number) => Promise<void>;
  unlock: () => Promise<boolean>;
}

const LockContext = createContext<LockValue | null>(null);

/**
 * App-level biometric / PIN lock (ADR-013). Money apps get handed around —
 * "check the split" should not mean "read my whole ledger".
 *
 * This guards the UI only; the data itself is protected by RLS regardless.
 */
export function LockProvider({ children }: { children: ReactNode }) {
  const [enabled, setEnabledState] = useState(false);
  const [locked, setLocked] = useState(false);
  const [supported, setSupported] = useState(false);
  const [graceSeconds, setGraceState] = useState(DEFAULT_GRACE_SECONDS);
  const [ready, setReady] = useState(false);

  /**
   * When the app was last backgrounded. A ref rather than state because the
   * listener needs the current value without being torn down and rebuilt as it
   * changes — a listener that re-subscribes mid-transition misses the
   * transition.
   */
  const leftAt = useRef<number | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      // SecureStore has no web implementation; the lock is a native feature.
      const hasHardware = Platform.OS !== 'web' && (await LocalAuthentication.hasHardwareAsync());
      await legacyKeysMigrated;
      const stored = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(KEY);
      const storedGrace = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(GRACE_KEY);
      if (!active) return;
      setSupported(hasHardware);
      const on = stored === 'true';
      setEnabledState(on);
      // A cold start is always locked, whatever the grace period says. The
      // grace is for coming back to a running app, not for reopening a killed
      // one — and "killed" is indistinguishable from "reinstalled by somebody
      // else holding the phone".
      setLocked(on);
      const parsed = Number(storedGrace);
      if (storedGrace !== null && Number.isFinite(parsed) && parsed >= 0) setGraceState(parsed);
      setReady(true);
    })();
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background' || state === 'inactive') {
        // Only the first departure counts. iOS reports `inactive` on the way to
        // `background`, and treating the second as a fresh departure would
        // restart the clock at the moment the phone was put down.
        leftAt.current ??= Date.now();
        return;
      }
      if (state !== 'active') return;
      const away = leftAt.current;
      leftAt.current = null;
      if (away === null) return;
      if (Date.now() - away >= graceSeconds * 1000) setLocked(true);
    });
    return () => subscription.remove();
  }, [enabled, graceSeconds]);

  const unlock = useCallback(async () => {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Waves',
      fallbackLabel: 'Use passcode',
    });
    if (result.success) setLocked(false);
    return result.success;
  }, []);

  const setEnabled = useCallback(async (value: boolean) => {
    if (value) {
      // Prove the device can actually unlock before locking them out of it.
      const result = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm to turn on app lock',
      });
      if (!result.success) return;
    }
    // SecureStore has no web implementation, same as the read path above.
    if (Platform.OS !== 'web') await SecureStore.setItemAsync(KEY, value ? 'true' : 'false');
    setEnabledState(value);
    setLocked(false);
  }, []);

  const setGraceSeconds = useCallback(async (value: number) => {
    if (Platform.OS !== 'web') await SecureStore.setItemAsync(GRACE_KEY, String(value));
    setGraceState(value);
  }, []);

  return (
    <LockContext.Provider
      value={{
        enabled,
        locked,
        supported,
        ready,
        graceSeconds,
        setEnabled,
        setGraceSeconds,
        unlock,
      }}
    >
      {children}
    </LockContext.Provider>
  );
}

export function useLock(): LockValue {
  const value = useContext(LockContext);
  if (!value) throw new Error('useLock must be used inside LockProvider');
  return value;
}

/**
 * When the personal ("Me") ledger was last unlocked. Module-scoped so leaving
 * the tab and coming back within the grace window does not re-prompt — the same
 * intent the app lock's grace has, applied per-screen rather than per-app.
 */
let personalAuthedAt: number | null = null;

/**
 * Whether a recent personal unlock still counts, read off render through a
 * function call (the React Compiler forbids `Date.now()` inline in a component,
 * the same reason `todayIso()` is hoisted). Lets the gate open with no cover on
 * a within-grace re-entry instead of flashing the shield first.
 */
export function personalGateFresh(graceSeconds: number): boolean {
  return personalAuthedAt !== null && Date.now() - personalAuthedAt < graceSeconds * 1000;
}

/**
 * A biometric gate for the private personal ledger, independent of the whole-app
 * lock. On entering the Me tab it asks the device to prove who is holding it and
 * keeps the screen obscured until it succeeds, so the figures are never on show
 * behind the prompt. It then stays quiet for the same "ask again after" window
 * the app lock uses (so the two share one setting) — a within-grace re-entry
 * opens straight away. A failed or cancelled check calls `onFail` (navigate off
 * the tab) rather than revealing anything. With nothing enrolled to authenticate
 * against there is nothing to ask, so it opens; RLS still guards the data on the
 * server. `onFail` should be stable (wrap it in useCallback).
 */
export function usePersonalGate(
  promptMessage: string,
  onFail: () => void,
): { unlocked: boolean; checking: boolean } {
  const { graceSeconds, supported } = useLock();
  // Start open only when a prior unlock is still within grace; otherwise start
  // covered so the first paint never shows the ledger.
  const [unlocked, setUnlocked] = useState(() => personalGateFresh(graceSeconds));
  const [checking, setChecking] = useState(false);

  const run = useCallback(async (): Promise<void> => {
    // Still inside the grace window from a recent success — open, no prompt.
    if (personalGateFresh(graceSeconds)) {
      setUnlocked(true);
      return;
    }
    // Nothing to authenticate against (no hardware, nothing enrolled, or web):
    // there is nothing to prompt for, so open. RLS still guards the data.
    const canAsk =
      Platform.OS !== 'web' && supported && (await LocalAuthentication.isEnrolledAsync());
    if (!canAsk) {
      personalAuthedAt = Date.now();
      setUnlocked(true);
      return;
    }
    // Keep it covered while the OS prompt is up so a cancel never flashes the
    // figures.
    setUnlocked(false);
    setChecking(true);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage,
      fallbackLabel: 'Use passcode',
    });
    setChecking(false);
    if (result.success) {
      personalAuthedAt = Date.now();
      setUnlocked(true);
    } else {
      onFail();
    }
  }, [graceSeconds, supported, promptMessage, onFail]);

  useFocusEffect(
    useCallback(() => {
      let active = true;
      // The check runs inside the async callback, not the effect body, so no
      // state is set synchronously on the render path.
      void (async () => {
        if (active) await run();
      })();
      // On blur, always re-cover: the tab stays mounted, so without this a
      // return after the grace lapsed would show the old figures for a frame
      // before the next prompt resolves. A within-grace return re-opens on the
      // next focus with no prompt, so the cost is at most a one-frame shield.
      return () => {
        active = false;
        setUnlocked(false);
      };
    }, [run]),
  );

  return { unlocked, checking };
}

/** "Straight away", "After 30 seconds" — the words the settings row uses too. */
export function describeGrace(seconds: number, t: UiStrings, locale: string): string {
  if (seconds <= 0) return t.lock.graceImmediate;
  if (seconds < 60) return plural(locale, seconds, t.lock.graceSeconds);
  return plural(locale, Math.round(seconds / 60), t.lock.graceMinutes);
}
