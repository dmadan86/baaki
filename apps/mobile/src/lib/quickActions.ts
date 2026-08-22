/**
 * The OS app-icon shortcut (iOS Home-Screen Quick Actions / Android App
 * Shortcuts), kept behind a runtime check.
 *
 * `expo-quick-actions` is a native module. On a JS-only reload of an older
 * dev-client — one built before the module was installed — reaching for it would
 * throw at launch. So nothing here imports it at module scope; every entry point
 * loads it lazily inside a try/catch and no-ops when it is not in the binary
 * (the same discipline the camera and scanner use). The in-app double-tap works
 * regardless; only the icon menu waits on a rebuild.
 */

import { Platform } from 'react-native';

import type { ShortcutAction } from './shortcut';

/** The dynamic-quick-action id we route on when the app is launched from one. */
export const QUICK_ACTION_ID = 'waves.shortcut';

type QuickActionsModule = {
  setItems: (items: unknown[]) => Promise<void> | void;
  isSupported?: () => Promise<boolean> | boolean;
  initial?: { id?: string } | null;
  addListener?: (fn: (item: { id?: string }) => void) => { remove: () => void };
};

function load(): QuickActionsModule | null {
  if (Platform.OS !== 'ios' && Platform.OS !== 'android') return null;
  try {
    // Lazy, guarded require: absent on a dev-client built before the module was
    // added, and we must not throw there.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-quick-actions') as {
      default?: QuickActionsModule;
    } & QuickActionsModule;
    return (mod.default ?? mod) as QuickActionsModule;
  } catch {
    return null;
  }
}

const ICON: Record<Exclude<ShortcutAction, 'off'>, string> = {
  // Symbol names resolve on iOS; Android falls back to no icon, which is fine.
  scan: 'symbol:camera',
  voice: 'symbol:mic',
  add: 'symbol:plus',
};

/**
 * Publish (or clear) the single icon shortcut for the chosen action. Called
 * whenever the setting changes, and once on start. A no-op without the module.
 */
export async function syncQuickAction(action: ShortcutAction, title: string): Promise<void> {
  const mod = load();
  if (!mod) return;
  try {
    if (action === 'off') {
      await mod.setItems([]);
      return;
    }
    await mod.setItems([{ id: QUICK_ACTION_ID, title, icon: ICON[action], params: { action } }]);
  } catch {
    // A device that cannot set shortcuts (an old OS, a launcher without support)
    // is not an error worth surfacing — the in-app gesture still works.
  }
}

/** The action id the app was cold-launched with, if it was launched from the
 *  icon shortcut. Null otherwise (or without the module). */
export function initialQuickAction(): string | null {
  const mod = load();
  return mod?.initial?.id ?? null;
}

/** Subscribe to icon-shortcut taps while the app is already running. Returns a
 *  no-op unsubscribe when the module is absent. */
export function onQuickAction(fn: (id: string) => void): () => void {
  const mod = load();
  if (!mod?.addListener) return () => undefined;
  const sub = mod.addListener((item) => {
    if (item?.id) fn(item.id);
  });
  return () => sub.remove();
}
