/**
 * The sync loop (ADR-005 / TDR §4).
 *
 * Everything the user does becomes a mutation in a durable queue and an
 * immediate change on screen. This engine is what eventually reconciles the two
 * with the server — on reconnect, on foreground, and on a timer while the app
 * is open.
 *
 * The rules about *what* to send and *how* to fold the answer back in live in
 * @waves/core, where they are property-tested without a device. What lives here
 * is the part that genuinely needs a phone: persistence, connectivity, timers
 * and the network call itself.
 */

import * as Network from 'expo-network';
import {
  applyOutcomes,
  dialingCodeForCountry,
  emptyMirror,
  enqueue as enqueueMutation,
  markFailed,
  MutationKind,
  nextBatch,
  normalisePhoneInRegion,
  reconcile,
  SyncTable,
  type MirrorRow,
  type MirrorState,
  type MutationEnvelope,
  type QueuedMutation,
  type SyncChange,
  type SyncRejectionCode,
} from '@waves/core';

import { reportHandled } from '@/lib/observability';
import { backend } from '@/lib/backend';
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
  /** The server truncated at least one table's page; more rows are waiting.
   *  Absent on older servers, so treated as false. */
  hasMore?: boolean;
}

/** While the app is open and online, catch anything Realtime missed. */
const POLL_INTERVAL_MS = 30_000;

/** A sync request that has connected but is never answered would otherwise hang
 * the flush in `Syncing` forever — and because `this.flushing` dedupes, every
 * later flush (including the 30s poll) would queue behind that dead one. Cap the
 * round trip so a silent server surfaces as an ordinary Error the UI can move
 * past, rather than an endless spinner. */
const SYNC_TIMEOUT_MS = 20_000;

/**
 * Reject if `promise` has not settled within `ms`. The timer is cleared the
 * moment it settles, so a healthy request pays nothing; a hung one rejects and
 * lands in the flush's existing catch. The underlying request is left to error
 * out on its own — its result is ignored either way.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}

/** Shallow-equal two cursor maps: same keys, same values. */
function sameCursors(a: Record<string, number>, b: Record<string, number>): boolean {
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  for (const key of keys) if (a[key] !== b[key]) return false;
  return true;
}

/** Same queue contents in the same order — by item identity, which
 * `applyOutcomes` preserves when it drops nothing. */
function sameQueue(a: readonly QueuedMutation[], b: readonly QueuedMutation[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function appendRejected(
  existing: readonly RejectedMutation[],
  incoming: readonly RejectedMutation[],
): RejectedMutation[] {
  if (incoming.length === 0) return [...existing];
  const byId = new Map(existing.map((item) => [item.clientMutationId, item]));
  for (const item of incoming) byId.set(item.clientMutationId, item);
  return [...byId.values()];
}

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
   *
   * A flush already in flight was started before the leave and may carry this
   * group's rows in its response; its `reconcile` runs against `this.state`
   * *after* the network await, so purging first would let that late response
   * re-add the group we just removed. Wait for it to land before removing, and
   * because the leave has already committed server-side, any flush that starts
   * afterwards can no longer see the group (RLS) and cannot bring it back.
   */
  async forgetGroup(groupId: string): Promise<void> {
    await this.flushing;

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
    // One durable step: the group's rows, its cursor and its unsent edits go
    // together, so a crash cannot leave the queue replaying against a group the
    // mirror has forgotten.
    await this.store.forgetGroup(groupId, queue);
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
    // The default is to sync on any connection; only if someone has chosen
    // Wi‑Fi-only does a phone on mobile data hold its queue until Wi‑Fi returns
    // — and the change is already safe on disk either way.
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
    //
    // Only announce "syncing" when there is something the user actually queued
    // to push. The 30s poll also runs this round trip to pull the mirror when
    // nothing is queued, and flipping to Syncing for that made the header glyph
    // blink and spin every interval for a routine background fetch nobody asked
    // to watch. A silent pull leaves the status where it was (Idle).
    if (batch.length > 0) this.set({ status: SyncStatus.Syncing });

    try {
      const { data, error } = await withTimeout(
        backend.functions.invoke('sync', {
          body: {
            deviceId: 'mobile',
            mutations: batch.map((item) => ({
              clientMutationId: item.clientMutationId,
              kind: item.kind,
              groupId: item.groupId,
              clientCreatedAt: item.clientCreatedAt,
              // Heal a bare "add member" phone right before it is (re)sent: read
              // it in the group's own region, so an old build's queued number —
              // or anything that slipped past entry normalisation — syncs
              // instead of being refused. The stored payload is left as-is; a
              // healthy send removes it from the queue anyway, and a failed one
              // is healed again next round.
              payload: this.healGhostPhonePayload(item.kind, item.groupId, item.payload),
            })),
            cursors,
          },
        }),
        SYNC_TIMEOUT_MS,
        'sync',
      );
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

      // Auto-heal a refused "add member" whose only fault was a bare, uncoded
      // phone: re-queue it with the number read in the group's region rather
      // than surfacing a banner the user has to act on. Anything we cannot heal
      // — no region, a genuinely invalid number, or a rejection for some other
      // reason — falls through to `rejected` and is shown as a friendly line.
      const requeue: MutationEnvelope[] = [];
      const stillRejected: {
        mutation: QueuedMutation;
        code: SyncRejectionCode;
        message: string;
      }[] = [];
      for (const entry of folded.rejected) {
        const healed = this.healRejectedGhostPhone(entry);
        if (healed) requeue.push(healed);
        else stillRejected.push(entry);
      }

      const rejected: RejectedMutation[] = stillRejected.map((entry) => ({
        clientMutationId: entry.mutation.clientMutationId,
        kind: entry.mutation.kind,
        groupId: entry.mutation.groupId,
        code: entry.code,
        message: entry.message,
      }));

      const changes = response.changes ?? [];
      const merged = reconcile(this.state.mirror, changes);
      // The server's cursors are authoritative: they also advance past rows
      // this client is not allowed to see, which stops the cursor stalling.
      const nextCursors = { ...merged.state.cursors, ...(response.cursors ?? {}) };

      // Hold the old references when this flush folded in nothing.
      //
      // The 30s poll (POLL_INTERVAL_MS) runs this round trip on a loop, and the
      // common answer is "nothing new": no rows to apply and the cursors already
      // where they are. reconcile still allocates a fresh tables/cursors object
      // and applyOutcomes a fresh queue array, so assigning them would hand the
      // mounted screens a new `mirror`/`queue` identity every interval — and
      // every useMemo keyed on [mirror, queue, …] (the home summary, people
      // balances, the group ledger) would recompute for a background fetch that
      // changed nothing: periodic jank nobody asked to watch. When nothing was
      // applied, keep the existing references so referential equality holds and
      // those memos stay put. When changes did land — or the cursors or queue
      // actually moved — this is exactly the old path: a new mirror, the folded
      // queue.
      const nothingApplied = changes.length === 0;
      const mirror: MirrorState =
        nothingApplied && sameCursors(this.state.mirror.cursors, nextCursors)
          ? this.state.mirror
          : { cursors: nextCursors, tables: merged.state.tables };
      const queue =
        folded.rejected.length === 0 && sameQueue(this.state.queue, folded.queue)
          ? this.state.queue
          : folded.queue;
      const madeProgress =
        changes.length > 0 || !sameCursors(this.state.mirror.cursors, nextCursors);

      await this.persist(changes, mirror, queue);

      this.set({
        status: SyncStatus.Idle,
        mirror,
        queue,
        rejected: appendRejected(this.state.rejected, rejected),
        lastSyncedAt: response.serverTime ?? new Date().toISOString(),
        lastError: null,
      });

      // The server capped a table at MAX_ROWS_PER_TABLE and left the cursor
      // below its high-water; the rest is still on the server. Drain it now
      // rather than waiting out the 30s poll, so a large backlog (a fresh device
      // joining a big group) catches up in a burst instead of a page every half
      // minute. Scheduled after this flush settles, since flush() is single-
      // in-flight; guarded by the cursor moving, so it cannot spin forever.
      if (response.hasMore && madeProgress) {
        setTimeout(() => void this.flush(), 0);
      }

      // Persist and send the healed re-queues. enqueue writes each to disk (so a
      // force-kill still keeps the correction) and its own flush is deduped
      // behind this in-flight one; a fresh flush once this settles pushes the
      // corrected member now rather than waiting out the 30s poll.
      if (requeue.length > 0) {
        for (const envelope of requeue) await this.enqueue(envelope);
        setTimeout(() => void this.flush(), 0);
      }
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

  // ─────────────────────────────────────────────── phone healing ──
  // A bare local number ("9535621101") has no country code, and the server
  // refuses it by design (a silent +91 would misroute an invite to a stranger).
  // Rather than let that surface as a raw banner, the number is read in the
  // group's own region — the same WhatsApp-style default every messaging app on
  // the phone already uses. There is no blind default: with the group carrying
  // no country the healers do nothing and the refusal becomes a friendly ask.
  //
  // The region is deliberately the *group's* country and nothing else: it keeps
  // this module free of any import that reaches react-native (its `deviceCountry`
  // lives behind expo-localization + RN's I18nManager, which cannot be parsed by
  // the pure vitest suite that imports this engine). The device/account fallback
  // stays where it belongs — the entry-point normalisers in the RN components,
  // which import react-native legitimately — so nothing here drags it in.

  /** The dialing code to read this group's bare numbers in, or null. */
  private regionDialCodeForGroup(groupId: string): string | null {
    const groups = this.state.mirror.tables[SyncTable.Groups] as
      Record<string, MirrorRow> | undefined;
    const group = groups?.[groupId] as { country_code?: unknown } | undefined;
    const groupCountry = typeof group?.country_code === 'string' ? group.country_code : null;
    return dialingCodeForCountry(groupCountry);
  }

  /**
   * The outbound payload for a mutation, with a bare "add member" phone read in
   * the group's region. Anything else is returned untouched. Best-effort: an
   * uncodeable or invalid number is left exactly as it was for the server to
   * answer, so this can never throw inside the flush.
   */
  private healGhostPhonePayload(kind: MutationKind, groupId: string, payload: unknown): unknown {
    if (kind !== MutationKind.MemberAddGhost) return payload;
    if (typeof payload !== 'object' || payload === null) return payload;
    const record = payload as Record<string, unknown>;
    const phone = typeof record.phone === 'string' ? record.phone : null;
    if (!phone || phone.trim().startsWith('+')) return payload;
    try {
      const healed = normalisePhoneInRegion(phone, this.regionDialCodeForGroup(groupId));
      return healed === phone ? payload : { ...record, phone: healed };
    } catch {
      return payload;
    }
  }

  /**
   * A corrected envelope for a refused "add member" whose number only lacked a
   * country code, or null when it cannot (or need not) be healed — a different
   * kind, a different refusal, no region, an already-coded or invalid number.
   *
   * The new client mutation id is derived from the rejected one (`…:healed`)
   * rather than freshly minted: the server never accepted the original, so this
   * is genuinely a new attempt (a different id, not a duplicate), while staying
   * deterministic and free of any UUID source that would reach react-native. The
   * `memberId` in the payload is carried through unchanged, so the healed add
   * still lands on the same member the caller chose.
   */
  private healRejectedGhostPhone(entry: {
    mutation: QueuedMutation;
    code: SyncRejectionCode | string;
    message: string;
  }): MutationEnvelope | null {
    if (entry.mutation.kind !== MutationKind.MemberAddGhost) return null;
    if (!/PHONE_NEEDS_COUNTRY_CODE|PHONE_NOT_VALID/.test(`${entry.code} ${entry.message}`)) {
      return null;
    }
    const payload = entry.mutation.payload as Record<string, unknown>;
    const phone = typeof payload.phone === 'string' ? payload.phone : null;
    if (!phone) return null;
    let healed: string;
    try {
      healed = normalisePhoneInRegion(phone, this.regionDialCodeForGroup(entry.mutation.groupId));
    } catch {
      return null;
    }
    // No change means the number already had a code (or none we can add) — do
    // not re-queue it, or a still-refused number would loop forever.
    if (healed === phone) return null;
    return {
      clientMutationId: `${entry.mutation.clientMutationId}:healed`,
      kind: MutationKind.MemberAddGhost,
      groupId: entry.mutation.groupId,
      clientCreatedAt: new Date().toISOString(),
      payload: { ...payload, phone: healed },
    };
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
