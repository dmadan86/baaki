/**
 * Light or dark, and the switch for it.
 *
 * Three states, not two: light, dark, and "whatever the phone says". The third
 * is the default and matters most — somebody who has told their phone to go
 * dark at sunset should not have to tell every app separately, and the design
 * ships a full dark palette (tokens.ts) precisely so following that setting
 * costs nothing.
 *
 * The chosen scheme is fed to `@baaki/ui`'s `ThemeProvider` as `forceScheme`;
 * a null preference leaves `forceScheme` undefined, so the design system falls
 * back to the OS scheme on its own.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useColorScheme } from 'react-native';

const KEY = 'baaki.theme_scheme';

/** What the user picked. Null means "follow the phone". */
export enum SchemePreference {
  Light = 'light',
  Dark = 'dark',
}

interface ThemeValue {
  /** The user's choice, or null when following the phone. */
  preference: SchemePreference | null;
  /** The scheme actually in force once the phone's setting is resolved. */
  resolved: 'light' | 'dark';
  /** What the phone's own setting says, for explaining the default. */
  systemScheme: 'light' | 'dark';
  /** True while the stored preference is still being read. */
  loading: boolean;
  /** Null puts it back under the system setting's control. */
  setPreference: (value: SchemePreference | null) => Promise<void>;
  /** Whether the person has overridden the system setting. */
  overridden: boolean;
}

const ThemePrefContext = createContext<ThemeValue | null>(null);

export function ThemePreferenceProvider({ children }: { children: ReactNode }) {
  const systemRaw = useColorScheme();
  const systemScheme: 'light' | 'dark' = systemRaw === 'dark' ? 'dark' : 'light';

  const [stored, setStored] = useState<SchemePreference | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      const saved = await AsyncStorage.getItem(KEY).catch(() => null);
      if (!active) return;
      setStored(
        saved === 'light'
          ? SchemePreference.Light
          : saved === 'dark'
            ? SchemePreference.Dark
            : null,
      );
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const setPreference = useCallback(async (value: SchemePreference | null) => {
    setStored(value);
    if (value === null) await AsyncStorage.removeItem(KEY).catch(() => undefined);
    else await AsyncStorage.setItem(KEY, value).catch(() => undefined);
  }, []);

  const value = useMemo<ThemeValue>(
    () => ({
      preference: stored,
      resolved:
        stored === SchemePreference.Dark
          ? 'dark'
          : stored === SchemePreference.Light
            ? 'light'
            : systemScheme,
      systemScheme,
      loading,
      setPreference,
      overridden: stored !== null,
    }),
    [stored, systemScheme, loading, setPreference],
  );

  return <ThemePrefContext.Provider value={value}>{children}</ThemePrefContext.Provider>;
}

export function useThemePreference(): ThemeValue {
  const value = useContext(ThemePrefContext);
  if (!value) throw new Error('useThemePreference must be used inside ThemePreferenceProvider');
  return value;
}
