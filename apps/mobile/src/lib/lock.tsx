import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import { AppState, Platform } from 'react-native';

const KEY = 'baaki.app_lock_enabled';

interface LockValue {
  /** Whether the user has turned the lock on. */
  enabled: boolean;
  /** Whether the app is currently waiting to be unlocked. */
  locked: boolean;
  supported: boolean;
  setEnabled: (value: boolean) => Promise<void>;
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

  useEffect(() => {
    let active = true;
    void (async () => {
      // SecureStore has no web implementation; the lock is a native feature.
      const hasHardware = Platform.OS !== 'web' && (await LocalAuthentication.hasHardwareAsync());
      const stored = Platform.OS === 'web' ? null : await SecureStore.getItemAsync(KEY);
      if (!active) return;
      setSupported(hasHardware);
      const on = stored === 'true';
      setEnabledState(on);
      setLocked(on);
    })();
    return () => {
      active = false;
    };
  }, []);

  // Re-lock when the app goes to the background, which is exactly when the
  // phone gets handed over.
  useEffect(() => {
    if (!enabled) return;
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'background') setLocked(true);
    });
    return () => subscription.remove();
  }, [enabled]);

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

  return (
    <LockContext.Provider value={{ enabled, locked, supported, setEnabled, unlock }}>
      {children}
    </LockContext.Provider>
  );
}

export function useLock(): LockValue {
  const value = useContext(LockContext);
  if (!value) throw new Error('useLock must be used inside LockProvider');
  return value;
}
