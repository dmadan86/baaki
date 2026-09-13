/**
 * Whether this phone is reading its own bank messages, and when it last looked.
 *
 * ⚠️ PLACEHOLDER. The automatic reader — the permission-granted backfill, the
 * `ContentObserver` while the app is open, the background check while it is
 * closed — is being built alongside this screen. This file exists so the Review
 * tab can be written against the *shape* of that answer rather than waiting for
 * it, and it is meant to be replaced wholesale by the real implementation. The
 * interface below is the contract and must not drift: `enabled` says whether
 * reading is live at all, `lastCheckedAt` is when the inbox was last swept,
 * `checking` is true while a sweep is in flight, and `refresh()` asks for one.
 *
 * What it answers today is "no". That is the honest placeholder: with nothing
 * reading, Review says nothing about watching, and every phone — Android
 * included — behaves exactly as an iPhone does, with pasting as the way in.
 * A status line that claimed to be watching when nothing was would be worse
 * than no line at all.
 */

import { useMemo } from 'react';

/** What the Review tab needs to know about the reader. The whole contract. */
export interface SmsAutoRead {
  /** Is the inbox actually being read on this phone, right now? */
  readonly enabled: boolean;
  /** ISO stamp of the last sweep, or null if there has never been one. */
  readonly lastCheckedAt: string | null;
  /** True while a sweep is running, so the status line can say so. */
  readonly checking: boolean;
  /** Ask for a sweep now. Resolves when it has finished (or failed quietly). */
  readonly refresh: () => Promise<void>;
}

const NOTHING_IS_READING: SmsAutoRead = {
  enabled: false,
  lastCheckedAt: null,
  checking: false,
  refresh: async () => {},
};

/**
 * The reader's state. Stable across renders, so a screen can put it in a
 * dependency list without re-running every frame.
 */
export function useSmsAutoRead(): SmsAutoRead {
  return useMemo(() => NOTHING_IS_READING, []);
}
