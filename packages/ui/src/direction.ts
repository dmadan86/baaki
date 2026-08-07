/**
 * Which way the layout runs, and the one thing React Native will not mirror for
 * you.
 *
 * RN already does most of the work: with `doLeftAndRightSwapInRTL` — true by
 * default — it swaps `left`/`right` in styles, reverses `flexDirection: 'row'`,
 * and flips `textAlign`. So `marginLeft` and `paddingRight` are *not* bugs in
 * an RTL app, and rewriting them all to `marginStart`/`paddingEnd` would be
 * churn that changes nothing.
 *
 * What it cannot mirror is an **icon**, because an icon is content. A chevron
 * called `chevron-forward` keeps pointing right in a screen that now runs the
 * other way, so "next" points backwards and "back" points onward. That is the
 * whole of this file.
 *
 * The flag is set once at startup from the app's own language rather than read
 * from `I18nManager.isRTL` on every call, for a reason worth stating: on web
 * `I18nManager.isRTL` is false even when the root view carries `dir="rtl"` and
 * the layout is visibly mirrored. Web is how this repo does its visual checks,
 * and a check that shows a mirrored screen with unmirrored arrows would be
 * checking the wrong thing.
 */

import { I18nManager } from 'react-native';

let rtl = I18nManager.isRTL;

/**
 * Tell the design system which way the app is running. Called once, at startup,
 * with the answer derived from the phone's language.
 */
export function setLayoutDirection(isRtl: boolean): void {
  rtl = isRtl;
}

export function isRtlLayout(): boolean {
  return rtl;
}

/** Icons whose meaning is a direction, and their mirror image. */
const MIRRORED: Readonly<Record<string, string>> = {
  'chevron-forward': 'chevron-back',
  'chevron-back': 'chevron-forward',
  'chevron-forward-outline': 'chevron-back-outline',
  'chevron-back-outline': 'chevron-forward-outline',
  'chevron-forward-circle': 'chevron-back-circle',
  'chevron-back-circle': 'chevron-forward-circle',
  'chevron-forward-circle-outline': 'chevron-back-circle-outline',
  'chevron-back-circle-outline': 'chevron-forward-circle-outline',
  'arrow-forward': 'arrow-back',
  'arrow-back': 'arrow-forward',
  'arrow-forward-outline': 'arrow-back-outline',
  'arrow-back-outline': 'arrow-forward-outline',
  'arrow-forward-circle': 'arrow-back-circle',
  'arrow-back-circle': 'arrow-forward-circle',
  'arrow-forward-circle-outline': 'arrow-back-circle-outline',
  'arrow-back-circle-outline': 'arrow-forward-circle-outline',
  'caret-forward': 'caret-back',
  'caret-back': 'caret-forward',
  'caret-forward-outline': 'caret-back-outline',
  'caret-back-outline': 'caret-forward-outline',
};

/**
 * The icon to draw, mirrored when the layout is.
 *
 * Only left/right icons are in the table. An up arrow, a tick and a camera mean
 * the same thing in every direction, and a blanket "flip anything with a
 * direction in its name" would turn `arrow-up` into nonsense.
 */
export function directionalIcon<T extends string>(name: T): T {
  if (!rtl) return name;
  return (MIRRORED[name] ?? name) as T;
}
