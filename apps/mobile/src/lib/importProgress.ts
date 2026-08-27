/**
 * A tiny global store for an in-flight ledger import, so the work survives the
 * screen that started it — and never ties up the app while it runs.
 *
 * The import screen hands the job here and walks home: this store runs the
 * import from plain module code (not tied to any component), and the dashboard
 * shows one banner above the group list through {@link useImportProgress}. When
 * it finishes, the new group animates into that list on its own.
 *
 * It reports *phases*, not a percentage. The import is a single transactional
 * RPC with no streaming, so there is no honest fraction to tick — and ticking a
 * fake one meant emitting many times a second, which re-rendered a heavy
 * dashboard on every tick and made the whole app crawl while a large import ran.
 * Now the store emits only on a real transition (running → success, or into the
 * offline wait), a handful of times total; the banner shows an indeterminate bar
 * that animates on the native driver, so a slow or stalled import costs the JS
 * thread nothing.
 *
 * Offline (Option B — deferred): with no connection the RPC cannot land, so the
 * store parks the job in a `waiting` phase and watches for connectivity; the
 * moment the phone is back online it runs the same job. The job is idempotent —
 * the group id and every mutation id are fixed by the caller — so a replay is a
 * replay, never a duplicate. The pending job lives in memory: it survives
 * navigation, not the app being killed.
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
  groupName: string;
  /** The imported group, known only once it has succeeded. */
  groupId: string | null;
  summary: ImportSummary | null;
  /** A people-facing message, set only in the error phase. */
  error: string | null;
}

const IDLE: ImportProgressSnapshot = {
  phase: 'idle',
  groupName: '',
  groupId: null,
  summary: null,
  error: null,
};

let snapshot: ImportProgressSnapshot = IDLE;
const listeners = new Set<() => void>();

// The timer that clears a finished banner, and the poll that watches for
// connectivity while a job is parked offline.
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

function toRunning(job: ImportJob): void {
  emit({ phase: 'running', groupName: job.name, groupId: null, summary: null, error: null });
}

/** Run the job now: resolve to success, park (offline), or fail. `mine` is the
 *  start token this attempt belongs to. */
function attempt(job: ImportJob, mine: number): void {
  toRunning(job);
  job.run().then(
    (result) => {
      if (token !== mine) return;
      emit({
        phase: 'success',
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
  pendingJob = job;
  emit({ phase: 'waiting', groupName: job.name, groupId: null, summary: null, error: null });
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
 * Start an import. Returns whether the job was scheduled: `false` when one is
 * already running or waiting (a second import is refused so a double tap cannot
 * fan out two writes), `true` once this job is on. The caller uses that to
 * decide whether to leave the import screen — dropping the job *and* navigating
 * away would strand the person's mapping unimported.
 *
 * If the phone is offline at the tap, the job is parked straight into `waiting`
 * rather than run and failed.
 */
export function beginImport(job: ImportJob): boolean {
  if (snapshot.phase === 'running' || snapshot.phase === 'waiting') return false;
  stopClear();
  stopNetWatch();
  pendingJob = null;
  const mine = ++token;

  // Show the banner at once, then decide: run if online, park if not. The
  // reachability check is a fast local call.
  toRunning(job);
  void isOnline().then((online) => {
    if (token !== mine) return;
    if (online) attempt(job, mine);
    else park(job, mine);
  });
  return true;
}

/** Clear the banner — the error/waiting dismiss, and the guard against a late
 *  resolve. Drops any parked job. */
export function dismissImport(): void {
  token++;
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

/** The group a just-finished import landed, or null. A primitive so a subscriber
 *  that only wants this (the dashboard, to animate the new row) re-renders on the
 *  success transition alone, not on every phase change. */
export function getImportedGroupId(): string | null {
  return snapshot.phase === 'success' ? snapshot.groupId : null;
}

/** React binding: the current import state, re-rendered as it advances. */
export function useImportProgress(): ImportProgressSnapshot {
  return useSyncExternalStore(subscribeImport, getImportSnapshot, getImportSnapshot);
}

/** React binding for just the landed group id (see {@link getImportedGroupId}). */
export function useImportedGroupId(): string | null {
  return useSyncExternalStore(subscribeImport, getImportedGroupId, getImportedGroupId);
}
