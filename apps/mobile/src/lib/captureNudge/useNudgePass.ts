/**
 * One pass over the reminder, from wherever the app happens to be.
 *
 * Two callers need exactly the same thing and must not each assemble it: the
 * headless `CaptureNudge`, which runs a pass when the inbox or the app's state
 * moves, and the switch on the notifications screen, which has to make its own
 * answer true the moment it is touched rather than at the next foreground. A
 * switch that takes effect later is a switch people press twice.
 *
 * The returned callback is fire-and-forget and never rejects: a reminder that
 * could not be set or cleared is reported to observability and otherwise
 * silent, because there is no screen this belongs on.
 */

import { useCallback } from 'react';

import { useCaptures } from '@/data/hooks';
import { plural, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { foldedCaptureCount } from '@/lib/captureBatch';
import { reportHandled } from '@/lib/observability';

import { syncCaptureNudge } from './run';

/** What the pass is about to be told, so a caller can key an effect on it. */
export interface NudgePassInputs {
  readonly ownerId: string;
  /** Waiting drafts, folded the way the dashboard badge folds them. */
  readonly waitingCount: number;
  /** When the oldest of them was saved, epoch ms. Null when none is waiting. */
  readonly oldestWaitingAt: number | null;
  readonly locale: string;
  /**
   * The mirror is off disk. Until it is, the count is "we have not looked", not
   * "nothing is waiting" — and acting on it would cancel this evening's
   * reminder on every single launch. The same trap `restorePrompt` is built
   * around.
   */
  readonly ready: boolean;
}

export function useNudgePassInputs(): NudgePassInputs {
  const { session } = useAuth();
  const ownerId = session?.user?.id ?? '';
  const captures = useCaptures();
  const { locale } = useStrings();

  const rows = captures.data;
  // A voice batch counts as one draft, exactly as the dashboard badge counts it
  // — one utterance must not read as four things waiting.
  const waitingCount = foldedCaptureCount(rows);
  // The oldest of them decides whether anything has been *sitting*. An
  // unparseable stamp is skipped rather than treated as the beginning of time,
  // which would turn one malformed row into a permanent reminder.
  let oldestWaitingAt: number | null = null;
  for (const row of rows) {
    const at = Date.parse(row.created_at);
    if (!Number.isFinite(at)) continue;
    if (oldestWaitingAt === null || at < oldestWaitingAt) oldestWaitingAt = at;
  }

  return {
    ownerId,
    waitingCount,
    oldestWaitingAt,
    locale,
    ready: ownerId !== '' && !captures.isLoading,
  };
}

/** Runs a pass with whatever is true right now. Safe to call from an event handler. */
export function useCaptureNudgePass(inputs: NudgePassInputs): () => void {
  const { t } = useStrings();
  const { ownerId, waitingCount, oldestWaitingAt, locale, ready } = inputs;

  return useCallback(() => {
    if (!ready) return;
    void syncCaptureNudge({
      ownerId,
      waitingCount,
      oldestWaitingAt,
      locale,
      now: Date.now(),
      // Rendered here, in the app's current language, because the words are
      // baked into the OS alarm at schedule time. `planCaptureNudge` reschedules
      // on a language change for exactly that reason.
      text: (count) => ({
        // The title never counts — the badge does, and the body says what the
        // badge is counting. See `captures.nudgeTitle` for why.
        title: t.captures.nudgeTitle,
        body: plural(locale, count, t.captures.nudgeBody),
      }),
    }).catch((error: unknown) => reportHandled(error, 'captureNudge.sync'));
  }, [ready, ownerId, waitingCount, oldestWaitingAt, locale, t]);
}
