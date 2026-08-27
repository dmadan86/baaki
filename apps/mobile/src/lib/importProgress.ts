/**
 * A tiny global store for an in-flight ledger import, so the work survives the
 * screen that started it — and now survives being offline.
 *
 * The import screen used to run the write itself and hold the person there
 * watching a bar. Now the tap hands the job here and walks home: this store
 * keeps running the import from plain module code — not tied to any component —
 * and the dashboard subscribes through {@link useImportProgress} to show one
 * banner above the group list. When it finishes, the new group animates into
 * that list on its own; the banner says its piece and clears itself.
 *
 * Offline (Option B — deferred): the import is one direct RPC, so with no
 * connection it cannot land. Rather than fail, the store parks the job in a
 * `waiting` phase and watches for connectivity; the moment the phone is back
 * online it runs the same job (idempotent — the group id and every mutation id
 * are fixed by the caller, so a replay is a replay, never a duplicate). The
 * pending job lives in memory: it survives navigation, not the app being killed.
 *
 * Built framework-free on the same shape as {@link ./transferProgress}: the job
 * is kicked from a callback and the UI reads it through `useSyncExternalStore`.
 */

import { useSyncExternalStore } from 'react';
import * as Network from 'expo-network';

export type ImportPhase = 'idle' | 'running' | 'waiting' | 'success' | 'error';

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
  /** The group's name, shown in the banner. */
  name: string;
  /**
   * The whole import — create/target the group, resolve members, write the
   * ledger, and pull it into the mirror — resolving with the group id and the
   * counts. It MUST be idempotent: the store may run it more than once (a
   * reconnect after an offline wait), so the caller fixes the group id and every
   * clientMutationId up front, making a re-run a replay. It should throw an
   * Error whose message is already people-facing (via friendlyError); the store
   * shows that message verbatim on a real failure.
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

// The easing ticker while running, the timer that clears a finished banner, and
// the poll that watches for connectivity while a job is parked offline.
let ease: ReturnType<typeof setInterval> | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;
let netWatch: ReturnType<typeof setInterval> | null = null;
// The job held for a reconnect while `phase === 'waiting'`.
let pendingJob: ImportJob | null = null;
// Bumped on every start and dismiss, so a job that resolves (or a net poll that
// fires) after a newer start — or after the banner was dismissed — cannot write
// stale state.
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

function stopNetWatch(): void {
  if (netWatch) {
    clearInterval(netWatch);
    netWatch = null;
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
/** How often, while parked offline, to check whether the phone is back online. */
const NET_POLL_MS = 4000;

/** The engine's own reachability check, kept in step with `sync/engine`: a
 *  reachable interface is online; unknown fails open (a genuinely bad request is
 *  caught below and parks the job anyway). */
async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    return state.isInternetReachable ?? state.isConnected ?? true;
  } catch {
    return true;
  }
}

/** Run the job now: ease the bar, then resolve to success, park (offline), or
 *  fail. `mine` is the start token this attempt belongs to. */
function attempt(job: ImportJob, mine: number): void {
  stopEase();
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
      // on Home animates itself in the moment the mirror gains the group.
      clearTimer = setTimeout(() => {
        if (token === mine) emit(IDLE);
      }, SUCCESS_LINGER_MS);
    },
    (caught: unknown) => {
      if (token !== mine) return;
      stopEase();
      // A write that failed because we dropped offline is not an error — it is a
      // wait. Anything else, online, is a real failure to show.
      void isOnline().then((online) => {
        if (token !== mine) return;
        if (!online) {
          park(job, mine);
        } else {
          const message = caught instanceof Error ? caught.message : String(caught);
          emit({
            phase: 'error',
            fraction: 0,
            groupName: job.name,
            groupId: null,
            summary: null,
            error: message,
          });
        }
      });
    },
  );
}

/** Hold the job for a reconnect, and start watching for one. */
function park(job: ImportJob, mine: number): void {
  stopEase();
  pendingJob = job;
  emit({
    phase: 'waiting',
    fraction: 0,
    groupName: job.name,
    groupId: null,
    summary: null,
    error: null,
  });
  stopNetWatch();
  netWatch = setInterval(() => {
    if (token !== mine) {
      stopNetWatch();
      return;
    }
    void isOnline().then((online) => {
      if (!online || token !== mine || snapshot.phase !== 'waiting' || !pendingJob) return;
      stopNetWatch();
      const job2 = pendingJob;
      pendingJob = null;
      attempt(job2, mine);
    });
  }, NET_POLL_MS);
}

/**
 * Start an import. A second call while one is already running or waiting is
 * ignored, so a double tap cannot fan out two writes.
 *
 * The bar is simulated on purpose: the import is a single transactional RPC with
 * no streaming, so there is no real fraction to report mid-flight. It eases
 * toward {@link EASE_CEILING} and only reaches a true 100% when the write
 * actually resolves. If the phone is offline at the tap, the job is parked
 * straight into `waiting` rather than run and failed.
 */
export function beginImport(job: ImportJob): void {
  if (snapshot.phase === 'running' || snapshot.phase === 'waiting') return;
  stopEase();
  stopClear();
  stopNetWatch();
  pendingJob = null;
  const mine = ++token;

  // Show the banner at once, then decide: run if online, park if not. The
  // reachability check is a fast local call, so any "running → waiting" flip is
  // within a frame or two.
  emit({
    phase: 'running',
    fraction: 0,
    groupName: job.name,
    groupId: null,
    summary: null,
    error: null,
  });
  void isOnline().then((online) => {
    if (token !== mine) return;
    if (online) attempt(job, mine);
    else park(job, mine);
  });
}

/** Clear the banner — the error/waiting dismiss, and the guard against a late
 *  resolve. Drops any parked job. */
export function dismissImport(): void {
  token++;
  stopEase();
  stopClear();
  stopNetWatch();
  pendingJob = null;
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
