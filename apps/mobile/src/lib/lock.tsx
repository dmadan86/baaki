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
import { AppState, Platform } from 'react-native';

import { plural, type UiStrings } from '@/i18n';

const KEY = 'baaki.app_lock_enabled';
const GRACE_KEY = 'baaki.app_lock_grace_seconds';

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
      promptMessage: 'Unlock Baaki',
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
    await SecureStore.setItemAsync(KEY, value ? 'true' : 'false');
    setEnabledState(value);
    setLocked(false);
  }, []);

  const setGraceSeconds = useCallback(async (value: number) => {
    await SecureStore.setItemAsync(GRACE_KEY, String(value));
    setGraceState(value);
  }, []);

  return (
    <LockContext.Provider
      value={{ enabled, locked, supported, graceSeconds, setEnabled, setGraceSeconds, unlock }}
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

/** "Straight away", "After 30 seconds" — the words the settings row uses too. */
export function describeGrace(seconds: number, t: UiStrings, locale: string): string {
  if (seconds <= 0) return t.lock.graceImmediate;
  if (seconds < 60) return plural(locale, seconds, t.lock.graceSeconds);
  return plural(locale, Math.round(seconds / 60), t.lock.graceMinutes);
}
