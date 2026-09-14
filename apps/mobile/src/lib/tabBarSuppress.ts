/**
 * A screen taking the bottom bar's room for as long as it needs it.
 *
 * The one bar (`components/AppTabBar`) is rendered at the root over the whole
 * navigation stack, and it decides where to show from the route alone
 * (`lib/tabBar`). That is right for every case it was written for — a screen is
 * a modal or it is not — and wrong for the one case it was not: a screen that
 * grows a footer of its own *while you are on it*.
 *
 * Review is that screen. Tick a draft and an action bar appears; because it is
 * an in-tree view and the bar is a root-level one painted over the stack, the
 * two stack up — a band of actions with the navigation under it, and the raised
 * mic sitting on top of the button you were reaching for. Neither can move out
 * of the other's way by route, because the route has not changed.
 *
 * So the bar takes a second input: a count of the screens currently asking it
 * to stand down. A count rather than a flag, because two things can ask at once
 * (a selection and a sheet) and the first to finish must not turn the bar back
 * on underneath the second. Each `suppressTabBar()` returns the release for its
 * own claim, and releasing twice is harmless.
 *
 * Deliberately not a context: the bar sits above every provider a screen might
 * add and re-rendering the whole tree to hide a footer would be a lot of work
 * for one boolean. `useSyncExternalStore` is exactly the shape of this — an
 * external value, read by the one component that cares.
 */

import { useSyncExternalStore } from 'react';

let claims = 0;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ask the bottom bar to stand down. Returns the release for *this* claim; call
 * it when the footer goes away (and in an effect's cleanup, so leaving the
 * screen mid-selection puts the bar back).
 */
export function suppressTabBar(): () => void {
  claims += 1;
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    claims = Math.max(0, claims - 1);
    emit();
  };
}

/** The current suppression state, split out so the counter can be tested without React. */
export function tabBarSuppressedSnapshot(): boolean {
  return claims > 0;
}

/** Whether anything is currently asking the bar to stand down. */
export function useTabBarSuppressed(): boolean {
  return useSyncExternalStore(
    subscribe,
    tabBarSuppressedSnapshot,
    // The server snapshot: nothing has claimed anything before the first render.
    () => false,
  );
}

/** Test seam: forget every claim. Never call this from the app. */
export function resetTabBarSuppression(): void {
  claims = 0;
  emit();
}
