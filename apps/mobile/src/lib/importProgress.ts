/**
 * A tiny global store for an in-flight ledger import, so the work survives the
 * screen that started it.
 *
 * The import screen used to run the write itself and hold the person there
 * watching a bar. Now the tap hands the job here and walks home: this store
 * keeps running the import from plain module code — not tied to any component —
 * and the dashboard subscribes through {@link useImportProgress} to show one
 * banner above the group list. When it finishes, the new group animates into
 * that list on its own; the banner says its piece and clears itself.
 *
 * Built framework-free on the same shape as {@link ./transferProgress}: the job
 * is kicked from a callback and the UI reads it through `useSyncExternalStore`,
 * so nothing about the import depends on the import screen still being mounted.
 */

import { useSyncExternalStore } from 'react';

export type ImportPhase = 'idle' | 'running' | 'success' | 'error';

/** What a finished import brought in — the counts the banner reads back. */
export interface ImportSummary {
  expenses: number;
  ghosts: number;
  settlements: number;
}

/** The result an import job resolves with: where it landed, and what it added. */
export type ImportResult = { groupId: string } & ImportSummary;

/** The unit of work the store runs: a display name and the async import itself. */
export interface ImportJob {
  /** The group's name, shown in the banner while the write is in flight. */
  name: string;
  /**
   * The whole import — create/target the group, resolve members, write the
   * ledger, and pull it into the mirror — resolving with the group id and the
   * counts. It should throw an Error whose message is already people-facing
   * (via friendlyError); the store shows that message verbatim on failure.
   */
  run: () => Promise<ImportResult>;
}

export interface ImportProgressSnapshot {
  phase: ImportPhase;
  /** 0‑1. Simulated while running (see below); exactly 1 only once it is done. */
  fraction: number;
  groupName: string;
  /** The imported group, known only once it has succeeded. */
  groupId: string | null;
  summary: ImportSummary | null;
  /** A people-facing message, set only in the error phase. */
  error: string | null;
}

const IDLE: ImportProgressSnapshot = {
  phase: 'idle',
  fraction: 0,
  groupName: '',
  groupId: null,
  summary: null,
  error: null,
};

let snapshot: ImportProgressSnapshot = IDLE;
const listeners = new Set<() => void>();

// The easing ticker while running, and the timer that clears a finished banner.
let ease: ReturnType<typeof setInterval> | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
// Bumped on every start and dismiss, so a job that resolves after a newer one
// has begun (or after the banner was dismissed) cannot write stale state.
let token = 0;

function emit(next: ImportProgressSnapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

function stopEase(): void {
  if (ease) {
    clearInterval(ease);
    ease = null;
  }
}

function stopClear(): void {
  if (clearTimer) {
    clearTimeout(clearTimer);
    clearTimer = null;
  }
}

/** Where the simulated bar tops out before completion, and how fast it decays
 *  toward it — a bar that eases to ~92% then waits reads as "almost there"
 *  without ever claiming to be done before it is. */
const EASE_CEILING = 0.92;
const EASE_RATE = 0.06;
const EASE_MS = 140;
/** How long a success banner lingers before it clears itself. */
const SUCCESS_LINGER_MS = 4200;

/**
 * Start an import. A second call while one is already running is ignored, so a
 * double tap on the import button cannot fan out two writes.
 *
 * The bar is simulated on purpose: the import is a single transactional RPC with
 * no streaming, so there is no real fraction to report mid-flight. It eases
 * toward {@link EASE_CEILING} on a decaying curve and only reaches a true 100%
 * when the write actually resolves — honest about the one thing that matters
 * (done or not) while still feeling alive.
 */
export function beginImport(job: ImportJob): void {
  if (snapshot.phase === 'running') return;
  stopEase();
  stopClear();
  const mine = ++token;

  emit({
    phase: 'running',
    fraction: 0,
    groupName: job.name,
    groupId: null,
    summary: null,
    error: null,
  });

  ease = setInterval(() => {
    if (token !== mine || snapshot.phase !== 'running') return;
    const next = snapshot.fraction + (EASE_CEILING - snapshot.fraction) * EASE_RATE;
    emit({ ...snapshot, fraction: next });
  }, EASE_MS);

  job.run().then(
    (result) => {
      if (token !== mine) return;
      stopEase();
      emit({
        phase: 'success',
        fraction: 1,
        groupName: job.name,
        groupId: result.groupId,
        summary: {
          expenses: result.expenses,
          ghosts: result.ghosts,
          settlements: result.settlements,
        },
        error: null,
      });
      // Leave the "added" banner up for a beat, then clear it. The new group row
      // on Home animates itself in the moment the mirror gains the group; the
      // banner does not have to stay for that.
      clearTimer = setTimeout(() => {
        if (token === mine) emit(IDLE);
      }, SUCCESS_LINGER_MS);
    },
    (caught: unknown) => {
      if (token !== mine) return;
      stopEase();
      const message = caught instanceof Error ? caught.message : String(caught);
      emit({
        phase: 'error',
        fraction: 0,
        groupName: job.name,
        groupId: null,
        summary: null,
        error: message,
      });
    },
  );
}

/** Clear the banner — the error dismiss, and the guard against a late resolve. */
export function dismissImport(): void {
  token++;
  stopEase();
  stopClear();
  emit(IDLE);
}

export function subscribeImport(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getImportSnapshot(): ImportProgressSnapshot {
  return snapshot;
}

/** React binding: the current import state, re-rendered as it advances. */
export function useImportProgress(): ImportProgressSnapshot {
  return useSyncExternalStore(subscribeImport, getImportSnapshot, getImportSnapshot);
}
