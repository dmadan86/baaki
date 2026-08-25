/**
 * A tiny global store for in-flight transfers, so a thin progress bar can track
 * work that happens outside React — the receipt upload queue flushes from plain
 * library code, not a component, and still needs to drive the bar.
 *
 * It is deliberately framework-free: `start`/`advance`/`end` are called from
 * anywhere (the queue, a future download path), and the UI subscribes through
 * `useSyncExternalStore`. The snapshot is a single aggregate — are we busy, and
 * how far along across everything in flight — because the bar shows one line for
 * the whole app, the way a browser shows one download bar for many files.
 */

import { useSyncExternalStore } from 'react';

interface Transfer {
  done: number;
  total: number;
}

const transfers = new Map<string, Transfer>();
const listeners = new Set<() => void>();

/** The one aggregate the bar renders. Recomputed only on change, cached so
 *  `useSyncExternalStore` sees a stable reference between mutations. */
export interface TransferSnapshot {
  /** True while at least one transfer is unfinished. */
  active: boolean;
  /** 0‑1 across every transfer, by count of steps done over total. */
  fraction: number;
}

const IDLE: TransferSnapshot = { active: false, fraction: 0 };
let snapshot: TransferSnapshot = IDLE;

function recompute(): void {
  let done = 0;
  let total = 0;
  for (const t of transfers.values()) {
    done += t.done;
    total += t.total;
  }
  const active = transfers.size > 0 && done < total;
  snapshot = active ? { active, fraction: total === 0 ? 0 : done / total } : IDLE;
}

function emit(): void {
  recompute();
  for (const listener of listeners) listener();
}

/** Begin a transfer of `total` steps under a caller-owned id (replaces any prior
 *  transfer with that id, so a re-run resets cleanly). */
export function startTransfer(id: string, total: number): void {
  transfers.set(id, { done: 0, total: Math.max(0, total) });
  emit();
}

/** Mark `done` steps complete for a transfer (absolute, not a delta). */
export function setTransferProgress(id: string, done: number): void {
  const t = transfers.get(id);
  if (!t) return;
  t.done = Math.min(t.total, Math.max(0, done));
  emit();
}

/** Finish and drop a transfer, so a completed run leaves nothing lingering. */
export function endTransfer(id: string): void {
  if (transfers.delete(id)) emit();
}

export function subscribeTransfers(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getTransferSnapshot(): TransferSnapshot {
  return snapshot;
}

/** React binding: the current aggregate, re-rendered as transfers change. */
export function useTransferProgress(): TransferSnapshot {
  return useSyncExternalStore(subscribeTransfers, getTransferSnapshot, getTransferSnapshot);
}
