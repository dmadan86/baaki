/**
 * A priority queue for the one-at-a-time prompts that fight over the first-run
 * screen — the coach-mark tour and the daily tip sheet today, more later.
 *
 * The problem it solves: on the very first Home open both the tour and the tip
 * sheet want the screen at once, and stacking a hint on top of a coach-mark is
 * noise. So each overlay claims a slot with a priority while it wants to show,
 * and only the highest-priority live claim is *granted*. When that one releases
 * (the tour finishes), the next in line is granted — after its own delay, so a
 * hint lands a beat after the tour clears rather than the same frame.
 *
 * Kept deliberately small: a claim is just an id and a number, the winner is the
 * live claim with the largest number, and a slot's `granted` is "am I the winner
 * (once my delay has passed)". No timers or ordering live in the provider; the
 * delay is the waiting slot's own concern.
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

interface PromptQueueValue {
  /** Register or update a claim; higher priority wins the screen. */
  claim: (id: string, priority: number) => void;
  /** Drop a claim — the next-highest live claim becomes the winner. */
  release: (id: string) => void;
  /** The id of the live claim with the highest priority, or `null` if none. */
  winnerId: string | null;
}

const PromptQueueContext = createContext<PromptQueueValue | null>(null);

export function PromptQueueProvider({ children }: { children: ReactNode }) {
  const [claims, setClaims] = useState<Record<string, number>>({});

  const claim = useCallback((id: string, priority: number) => {
    setClaims((prev) => (prev[id] === priority ? prev : { ...prev, [id]: priority }));
  }, []);

  const release = useCallback((id: string) => {
    setClaims((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // The winner is the highest-priority live claim. `>` keeps the first-inserted
  // on a tie, but priorities are meant to be distinct, so ties should not arise.
  const winnerId = useMemo(() => {
    let best: string | null = null;
    let bestPriority = -Infinity;
    for (const [id, priority] of Object.entries(claims)) {
      if (priority > bestPriority) {
        bestPriority = priority;
        best = id;
      }
    }
    return best;
  }, [claims]);

  const value = useMemo<PromptQueueValue>(
    () => ({ claim, release, winnerId }),
    [claim, release, winnerId],
  );

  return <PromptQueueContext.Provider value={value}>{children}</PromptQueueContext.Provider>;
}

/**
 * Claim a slot in the prompt queue while `active`, and learn whether this slot
 * is cleared to show right now.
 *
 * `granted` is true only when this slot is the queue's winner *and* its
 * `delayMs` has elapsed since it became the winner. A higher-priority claim
 * appearing pulls `granted` straight back to false and cancels the wait, so a
 * tip that was a beat from showing steps aside the instant the tour starts.
 */
export function usePromptSlot({
  id,
  priority,
  active,
  delayMs = 0,
}: {
  id: string;
  priority: number;
  active: boolean;
  delayMs?: number;
}): boolean {
  const ctx = useContext(PromptQueueContext);
  if (!ctx) throw new Error('usePromptSlot must be used within a PromptQueueProvider');
  const { claim, release, winnerId } = ctx;

  useEffect(() => {
    if (active) claim(id, priority);
    else release(id);
    return () => release(id);
  }, [id, priority, active, claim, release]);

  const isWinner = active && winnerId === id;
  const [granted, setGranted] = useState(false);

  // Grant from the timer callback and revoke in the cleanup, never in the effect
  // body: a synchronous setState there cascades renders (and trips the lint). A
  // zero delay still routes through the timer, one tick later — cheap and lets
  // the two paths share one shape. Losing the winner (or a delay change) runs
  // the cleanup, which clears any pending grant and pulls `granted` back down, so
  // a higher-priority claim taking over stands this slot straight back down.
  useEffect(() => {
    if (!isWinner) return undefined;
    const timer = setTimeout(() => setGranted(true), Math.max(0, delayMs));
    return () => {
      clearTimeout(timer);
      setGranted(false);
    };
  }, [isWinner, delayMs]);

  return granted;
}
