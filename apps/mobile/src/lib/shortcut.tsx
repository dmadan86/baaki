/**
 * The quick shortcut — one action the user can fire two ways: a two-finger
 * double-tap anywhere in the app (the iOS "Magic Tap" convention), and the
 * app-icon long-press menu on the home screen. Both do the same thing, chosen
 * on the Shortcut settings screen: scan a receipt, speak an expense, or open the
 * add-expense form. "Off" disables both.
 *
 * The choice lives in AsyncStorage (a preference, not ledger data), loaded once
 * on start. `run()` is stable and reads the latest choice through a ref, so the
 * gesture and the icon listener never need re-binding when the setting changes.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { router } from 'expo-router';

import { useStrings } from '@/i18n';
import { syncQuickAction } from './quickActions';

/** What the shortcut does. `off` disables both triggers. */
export type ShortcutAction = 'off' | 'scan' | 'voice' | 'add';

const ACTION_KEY = 'shortcut.action';
const DOUBLE_TAP_KEY = 'shortcut.doubleTap';

const ACTIONS: readonly ShortcutAction[] = ['off', 'scan', 'voice', 'add'];

function isAction(value: string | null): value is ShortcutAction {
  return value !== null && (ACTIONS as readonly string[]).includes(value);
}

interface ShortcutValue {
  /** The chosen action; `off` until loaded, so nothing fires before the
   *  preference is read. */
  action: ShortcutAction;
  /** Whether the two-finger double-tap gesture is armed. */
  doubleTap: boolean;
  loading: boolean;
  setAction: (action: ShortcutAction) => Promise<void>;
  setDoubleTap: (on: boolean) => Promise<void>;
  /** Perform the current action now (no-op when `off`). Stable identity. */
  run: () => void;
}

const ShortcutContext = createContext<ShortcutValue | null>(null);

export function ShortcutProvider({ children }: { children: ReactNode }) {
  const { t } = useStrings();
  const [action, setActionState] = useState<ShortcutAction>('off');
  const [doubleTap, setDoubleTapState] = useState(true);
  const [loading, setLoading] = useState(true);

  // `run` reads the live action through this, so it never needs re-creating.
  // Written in an effect (not during render) and read only later, from a
  // gesture or the icon listener — long after this has committed.
  const actionRef = useRef<ShortcutAction>('off');
  useEffect(() => {
    actionRef.current = action;
  }, [action]);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [savedAction, savedTap] = await Promise.all([
        AsyncStorage.getItem(ACTION_KEY).catch(() => null),
        AsyncStorage.getItem(DOUBLE_TAP_KEY).catch(() => null),
      ]);
      if (!active) return;
      if (isAction(savedAction)) setActionState(savedAction);
      // Default on: an armed gesture is the point of setting an action at all.
      setDoubleTapState(savedTap === null ? true : savedTap === 'true');
      setLoading(false);
    })();
    return () => {
      active = false;
    };
  }, []);

  const titleFor = useCallback(
    (value: ShortcutAction): string =>
      value === 'scan'
        ? t.shortcut.optionScan
        : value === 'voice'
          ? t.shortcut.optionVoice
          : value === 'add'
            ? t.shortcut.optionAdd
            : t.shortcut.optionOff,
    [t],
  );

  // Keep the OS icon shortcut in step with the choice (a no-op without the
  // native module — see quickActions). Runs on load and on every change.
  useEffect(() => {
    if (loading) return;
    void syncQuickAction(action, titleFor(action));
  }, [action, loading, titleFor]);

  const setAction = useCallback(async (next: ShortcutAction) => {
    setActionState(next);
    await AsyncStorage.setItem(ACTION_KEY, next).catch(() => undefined);
  }, []);

  const setDoubleTap = useCallback(async (on: boolean) => {
    setDoubleTapState(on);
    await AsyncStorage.setItem(DOUBLE_TAP_KEY, String(on)).catch(() => undefined);
  }, []);

  const run = useCallback(() => {
    switch (actionRef.current) {
      case 'scan':
        // A fresh nonce so the capture screen's consume-once scan guard survives
        // Android recreating it (same as the dashboard scan button).
        router.push(`/capture?scan=${Date.now()}`);
        break;
      case 'voice':
        router.push('/voice');
        break;
      case 'add':
        router.push('/capture');
        break;
      default:
        break;
    }
  }, []);

  const value = useMemo<ShortcutValue>(
    () => ({ action, doubleTap, loading, setAction, setDoubleTap, run }),
    [action, doubleTap, loading, setAction, setDoubleTap, run],
  );

  return <ShortcutContext.Provider value={value}>{children}</ShortcutContext.Provider>;
}

export function useShortcut(): ShortcutValue {
  const value = useContext(ShortcutContext);
  if (!value) throw new Error('useShortcut must be used inside ShortcutProvider');
  return value;
}
