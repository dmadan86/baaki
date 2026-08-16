/**
 * The sync loop (ADR-005 / TDR §4).
 *
 * Everything the user does becomes a mutation in a durable queue and an
 * immediate change on screen. This engine is what eventually reconciles the two
 * with the server — on reconnect, on foreground, and on a timer while the app
 * is open.
 *
 * The rules about *what* to send and *how* to fold the answer back in live in
 * @baaki/core, where they are property-tested without a device. What lives here
 * is the part that genuinely needs a phone: persistence, connectivity, timers
 * and the network call itself.
 */

import * as Network from 'expo-network';
import {
  applyOutcomes,
  emptyMirror,
  enqueue as enqueueMutation,
  markFailed,
  nextBatch,
  reconcile,
  SyncTable,
  type MirrorRow,
  type MirrorState,
  type MutationEnvelope,
  type QueuedMutation,
  type SyncChange,
  type SyncRejectionCode,
} from '@baaki/core';

import { reportHandled } from '@/lib/observability';
import { supabase } from '@/lib/supabase';
import { loadSyncNetworkPreference, SyncNetworkPreference } from '@/lib/syncNetwork';

import { createLocalStore, type LocalStore, type StoredRow } from './store';

export enum SyncStatus {
  Idle = 'idle',
  Syncing = 'syncing',
  Offline = 'offline',
  /** Online, but the connection is not one the user allows sync over. */
  Metered = 'metered',
  Error = 'error',
}

export interface RejectedMutation {
  clientMutationId: string;
  kind: string;
  groupId: string;
  code: SyncRejectionCode | string;
  message: string;
}

export interface SyncState {
  status: SyncStatus;
  hydrated: boolean;
  mirror: MirrorState;
  queue: QueuedMutation[];
  /** Mutations the server refused. They need a person, not another retry. */
  rejected: RejectedMutation[];
  lastSyncedAt: string | null;
  lastError: string | null;
}

interface SyncResponseBody {
  outcomes: {
    clientMutationId: string;
    status: 'applied' | 'duplicate' | 'rejected';
    code?: string;
    message?: string;
  }[];
  changes: SyncChange[];
  cursors: Record<string, number>;
  serverTime: string;
}

/** While the app is open and online, catch anything Realtime missed. */
const POLL_INTERVAL_MS = 30_000;

export class SyncEngine {
  private store: LocalStore = createLocalStore();
  private state: SyncState = {
    status: SyncStatus.Idle,
    hydrated: false,
    mirror: emptyMirror(),
    queue: [],
    rejected: [],
    lastSyncedAt: null,
    lastError: null,
  };

  private listeners = new Set<(state: SyncState) => void>();
  private flushing: Promise<void> | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  subscribe(listener: (state: SyncState) => void): () => void {
    this.listeners.add(listener);
    listener(this.state);
    return () => this.listeners.delete(listener);
  }

  getState(): SyncState {
    return this.state;
  }

  private set(patch: Partial<SyncState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener(this.state);
  }

  /**
   * Rebuild the mirror from disk. Until this finishes the app has no local
   * data, which is why the UI waits on `hydrated` rather than rendering an
   * empty ledger that would look exactly like a group with no expenses.
   */
  async hydrate(): Promise<void> {
    await this.store.ready();
    const [rows, cursors, queue] = await Promise.all([
      this.store.readRows(),
      this.store.readCursors(),
      this.store.readQueue(),
    ]);

    const tables = emptyMirror().tables as Record<SyncTable, Record<string, MirrorRow>>;
    for (const row of rows) {
      tables[row.table] ??= {};
      tables[row.table][row.id] = row.row;
    }

    this.set({ hydrated: true, mirror: { cursors, tables }, queue });
  }

  start(): void {
    this.timer ??= setInterval(() => void this.flush(), POLL_INTERVAL_MS);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Sign-out: nothing of the previous account may survive on the device. */
  async clear(): Promise<void> {
    await this.store.reset();
    this.set({
      mirror: emptyMirror(),
      queue: [],
      rejected: [],
      status: SyncStatus.Idle,
      lastError: null,
      lastSyncedAt: null,
    });
  }

  /**
   * Leaving a group (ADR-006): forget it locally, at once.
   *
   * Leaving flips `left_at`, and `is_group_member` gates the group's RLS — so
   * the moment you leave, a pull can no longer see the group and can never send
   * the "it is gone" that a soft-delete would. Nothing else would ever drop it
   * from the mirror, and `materialiseGroups` keys off `archived_at`, not your
   * membership, so a left group would sit on the dashboard forever. Leaving is
   * the one change the client applies itself: drop the group's rows, its cursor
   * and any of its still-unsent edits, in memory and on disk together.
   */
  async forgetGroup(groupId: string): Promise<void> {
    const tables = {} as Record<SyncTable, Record<string, MirrorRow>>;
    for (const table of Object.keys(this.state.mirror.tables) as SyncTable[]) {
      const kept: Record<string, MirrorRow> = {};
      for (const [id, row] of Object.entries(this.state.mirror.tables[table])) {
        // The groups row is the group itself (keyed by its id); every other
        // table's rows carry the group they belong to.
        const belongs = table === SyncTable.Groups ? id === groupId : row.group_id === groupId;
        if (!belongs) kept[id] = row;
      }
      tables[table] = kept;
    }
    const cursors = { ...this.state.mirror.cursors };
    delete cursors[groupId];
    const queue = this.state.queue.filter((mutation) => mutation.groupId !== groupId);

    this.set({ mirror: { tables, cursors }, queue });
    await this.store.forgetGroup(groupId);
    await this.store.writeQueue(queue);
  }

  /**
   * Queue a mutation and show its effect immediately. The write is persisted
   * before this resolves, so a force-kill on the next line still syncs it.
   */
  async enqueue(envelope: MutationEnvelope): Promise<void> {
    const queue = enqueueMutation(this.state.queue, envelope);
    this.set({ queue });
    await this.store.writeQueue(queue);
    void this.flush();
  }

  async retry(clientMutationId: string): Promise<void> {
    const queue = this.state.queue.map((item) =>
      item.clientMutationId === clientMutationId
        ? { ...item, attempts: 0, nextAttemptAt: 0, lastError: null }
        : item,
    );
    this.set({
      queue,
      rejected: this.state.rejected.filter((item) => item.clientMutationId !== clientMutationId),
    });
    await this.store.writeQueue(queue);
    void this.flush();
  }

  async discard(clientMutationId: string): Promise<void> {
    const queue = this.state.queue.filter((item) => item.clientMutationId !== clientMutationId);
    this.set({
      queue,
      rejected: this.state.rejected.filter((item) => item.clientMutationId !== clientMutationId),
    });
    await this.store.writeQueue(queue);
  }

  /** Push the queue and pull whatever changed. Safe to call at any time. */
  flush(options: { groupIds?: string[] } = {}): Promise<void> {
    // One in flight at a time: two concurrent flushes would send the same batch
    // twice. Harmless thanks to idempotency, but it wastes a round trip and
    // makes the outcome bookkeeping race.
    this.flushing ??= this.runFlush(options)
      .catch((error: unknown) => {
        // Hydration and disk failures arrive here. Flush is fired and forgotten
        // from four places — a timer, foreground, reconnect and every enqueue —
        // so a rejection has nobody waiting on it and lands on the screen as an
        // uncaught promise rejection instead. The banner is where this belongs.
        const message = error instanceof Error ? error.message : String(error);
        reportHandled(error, 'sync.flush');
        this.set({ status: SyncStatus.Error, lastError: message });
      })
      .finally(() => {
        this.flushing = null;
      });
    return this.flushing;
  }

  private async runFlush(options: { groupIds?: string[] }): Promise<void> {
    if (!this.state.hydrated) await this.hydrate();

    const online = await isOnline();
    if (!online) {
      this.set({ status: SyncStatus.Offline });
      return;
    }

    // Online, but maybe not over a connection the user has agreed to spend.
    // Wi‑Fi is the default, so a phone on mobile data holds its queue rather
    // than syncing until Wi‑Fi returns — the change is already safe on disk.
    if (!(await networkAllowed())) {
      this.set({ status: SyncStatus.Metered });
      return;
    }

    const now = Date.now();
    const batch = nextBatch(this.state.queue, { now });
    const cursors = { ...this.state.mirror.cursors };
    for (const groupId of options.groupIds ?? []) cursors[groupId] ??= 0;

    // An empty mirror with nothing queued is not "nothing to do" — it is exactly
    // the first run that has to ask. Signing in on a new phone, or into an
    // account whose groups were created on another device, leaves the mirror
    // empty, and the only place the group ids live is the server: the `sync`
    // function reads the caller's own memberships and hands them back whatever
    // the cursors say (see its `group_members` query). Skipping the call here
    // meant those groups never arrived and home stayed empty until a deep link
    // happened to name one. The `!online` case already returned above, so the
    // one round trip this costs a brand-new guest is against their own empty
    // ledger, once, and tells them the truth either way.
    this.set({ status: SyncStatus.Syncing });

    try {
      const { data, error } = await supabase.functions.invoke('sync', {
        body: {
          deviceId: 'mobile',
          mutations: batch.map((item) => ({
            clientMutationId: item.clientMutationId,
            kind: item.kind,
            groupId: item.groupId,
            clientCreatedAt: item.clientCreatedAt,
            payload: item.payload,
          })),
          cursors,
        },
      });
      if (error) throw new Error(await describeFunctionError(error));

      const response = data as SyncResponseBody;
      const outcomes = response.outcomes ?? [];

      const folded = applyOutcomes(
        this.state.queue,
        outcomes.map((outcome) =>
          outcome.status === 'rejected'
            ? {
                clientMutationId: outcome.clientMutationId,
                status: 'rejected' as const,
                code: (outcome.code ?? 'VALIDATION_FAILED') as SyncRejectionCode,
                message: outcome.message ?? 'The server refused this change',
              }
            : { clientMutationId: outcome.clientMutationId, status: outcome.status },
        ),
      );

      const rejected: RejectedMutation[] = folded.rejected.map((entry) => ({
        clientMutationId: entry.mutation.clientMutationId,
        kind: entry.mutation.kind,
        groupId: entry.mutation.groupId,
        code: entry.code,
        message: entry.message,
      }));

      const merged = reconcile(this.state.mirror, response.changes ?? []);
      const mirror: MirrorState = {
        // The server's cursors are authoritative: they also advance past rows
        // this client is not allowed to see, which stops the cursor stalling.
        cursors: { ...merged.state.cursors, ...(response.cursors ?? {}) },
        tables: merged.state.tables,
      };

      await this.persist(response.changes ?? [], mirror, folded.queue);

      this.set({
        status: SyncStatus.Idle,
        mirror,
        queue: folded.queue,
        rejected: [...this.state.rejected, ...rejected],
        lastSyncedAt: response.serverTime ?? new Date().toISOString(),
        lastError: null,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const queue = markFailed(this.state.queue, batch, message, now);
      this.set({ status: SyncStatus.Error, queue, lastError: message });
      // Writing down *why* the sync failed must not itself become a louder
      // failure that replaces the reason. The attempt counts are already in
      // memory and the next flush writes them again.
      await this.store.writeQueue(queue).catch((writeError: unknown) => {
        reportHandled(writeError, 'sync.markFailed');
      });
    }
  }

  private async persist(
    changes: readonly SyncChange[],
    mirror: MirrorState,
    queue: readonly QueuedMutation[],
  ): Promise<void> {
    const rows: StoredRow[] = [];
    for (const change of changes) {
      const id = typeof change.row.id === 'string' ? change.row.id : null;
      if (!id) continue;
      rows.push({
        table: change.table,
        id,
        groupId: change.groupId,
        seq: change.seq,
        row: change.row,
      });
    }
    await this.store.putRows(rows);
    await this.store.writeCursors(mirror.cursors);
    await this.store.writeQueue(queue);
  }

  // ───────────────────────────────────────────────────── drafts ──
  // ADR-005: "drafts autosave to SQLite on every keystroke", so the crash that
  // loses half an entry — the complaint that made this a requirement — cannot
  // happen.

  saveDraft(key: string, value: unknown): Promise<void> {
    return this.store.writeDraft(key, value);
  }

  readDraft<T>(key: string): Promise<T | null> {
    return this.store.readDraft<T>(key);
  }

  clearDraft(key: string): Promise<void> {
    return this.store.clearDraft(key);
  }

  listDrafts(): Promise<{ key: string; value: unknown; savedAt: string }[]> {
    return this.store.listDrafts();
  }
}

async function isOnline(): Promise<boolean> {
  try {
    const state = await Network.getNetworkStateAsync();
    // `isInternetReachable` is undefined on some platforms; a connected
    // interface is the best signal available there, and a failed request is
    // handled by the backoff anyway.
    return state.isInternetReachable ?? state.isConnected ?? true;
  } catch {
    return true;
  }
}

/**
 * Whether the current connection is one the user allows sync over. "Both" is
 * always allowed; the specific choices are matched against the interface type.
 *
 * Fail-open on both fronts: if the preference or the network type can't be
 * read, we sync rather than silently stall a ledger. An unknown type only
 * happens off real phones (web/desktop), where "Wi‑Fi only" is not a
 * meaningful gate anyway, and a genuinely bad request is caught by the backoff.
 */
async function networkAllowed(): Promise<boolean> {
  const preference = await loadSyncNetworkPreference().catch(() => SyncNetworkPreference.Both);
  if (preference === SyncNetworkPreference.Both) return true;
  try {
    const { type } = await Network.getNetworkStateAsync();
    if (type == null) return true;
    return preference === SyncNetworkPreference.Wifi
      ? type === Network.NetworkStateType.WIFI
      : type === Network.NetworkStateType.CELLULAR;
  } catch {
    return true;
  }
}

async function describeFunctionError(error: unknown): Promise<string> {
  const context = (error as { context?: Response }).context;
  if (context && typeof context.json === 'function') {
    try {
      const body = (await context.json()) as { code?: string; message?: string };
      if (body?.message) return body.code ? `${body.code}: ${body.message}` : body.message;
    } catch {
      /* fall through */
    }
  }
  return error instanceof Error ? error.message : String(error);
}

export const syncEngine = new SyncEngine();
