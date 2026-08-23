/**
 * The watch ⇄ phone relay contract.
 *
 * Waves' smartwatch companions (Apple Watch, Wear OS) hold no ledger logic:
 * they send small intents to the paired phone, which does the real work through
 * the same offline queue, split math and voice parser the app already uses, and
 * relays results back. This module is that contract — the message shapes and a
 * strict decoder — kept here in `@waves/core` because it is pure (no React,
 * Supabase, Node or native deps) and is the single source of truth the phone
 * bridge and both native watch apps encode against.
 *
 * Money crosses the wire as a decimal-string of minor units (bigint has no JSON
 * form), exactly like the mutation-queue boundary (`serialiseCapture`).
 */

/** Bumped only on a breaking change to the shapes below. */
export const WATCH_RELAY_VERSION = 1 as const;

/** The recent-list sizes the phone offers; the watch never asks for another. */
export const RECENT_COUNT_OPTIONS = [3, 5, 10] as const;
export type RecentCount = (typeof RECENT_COUNT_OPTIONS)[number];
export const DEFAULT_RECENT_COUNT: RecentCount = 5;

/** Clamp any stored/received number to an offered size. */
export function coerceRecentCount(value: unknown): RecentCount {
  const n = typeof value === 'number' ? value : Number(value);
  return (RECENT_COUNT_OPTIONS as readonly number[]).includes(n)
    ? (n as RecentCount)
    : DEFAULT_RECENT_COUNT;
}

/** A single row the watch renders in its recent-expenses list. */
export interface WatchRecentItem {
  /** e.g. the expense note or "Added an expense". */
  title: string;
  /** e.g. the group name, or "Personal". */
  subtitle: string;
  /** Preformatted money, e.g. "₹1,200". Formatted on the phone so the watch
   *  needs no currency tables. */
  amountText: string;
  /** Preformatted relative time, e.g. "2h ago". */
  whenText: string;
}

/** Messages the watch sends to the phone. */
export type WatchToPhone =
  | { t: 'quickAdd'; amountMinor: string; currency: string; note: string }
  | { t: 'voiceAdd'; transcript: string }
  | { t: 'requestRecent'; count: number }
  | { t: 'notifAction'; actionId: string; objectId: string };

/** Messages the phone sends to the watch. */
export type PhoneToWatch =
  | { t: 'recent'; items: WatchRecentItem[] }
  | { t: 'settings'; recentCount: RecentCount }
  | { t: 'ack'; ok: boolean; error?: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+$/.test(value);
}

/**
 * Decode an untrusted message from the watch, rejecting anything malformed.
 *
 * The native channels (WatchConnectivity, the Wearable Data Layer) hand across
 * loosely-typed dictionaries, so every field is checked before the bridge acts
 * on it — a bad `quickAdd` must never reach the mutation queue.
 */
export function parseWatchToPhone(raw: unknown): WatchToPhone | null {
  if (!isRecord(raw)) return null;
  switch (raw.t) {
    case 'quickAdd':
      return isDecimalString(raw.amountMinor) &&
        raw.amountMinor !== '0' &&
        raw.amountMinor[0] !== '-' &&
        typeof raw.currency === 'string' &&
        raw.currency.length > 0 &&
        typeof raw.note === 'string'
        ? { t: 'quickAdd', amountMinor: raw.amountMinor, currency: raw.currency, note: raw.note }
        : null;
    case 'voiceAdd':
      return typeof raw.transcript === 'string' && raw.transcript.trim().length > 0
        ? { t: 'voiceAdd', transcript: raw.transcript }
        : null;
    case 'requestRecent':
      return { t: 'requestRecent', count: coerceRecentCount(raw.count) };
    case 'notifAction':
      return typeof raw.actionId === 'string' &&
        raw.actionId.length > 0 &&
        typeof raw.objectId === 'string' &&
        raw.objectId.length > 0
        ? { t: 'notifAction', actionId: raw.actionId, objectId: raw.objectId }
        : null;
    default:
      return null;
  }
}

/**
 * The phone→watch side is produced only by our own code, so it needs no
 * decoder — but this keeps the shapes honest and gives the native apps a single
 * documented envelope. `version` lets a watch ignore a newer phone it can't read.
 */
export function encodePhoneToWatch(msg: PhoneToWatch): Record<string, unknown> {
  return { version: WATCH_RELAY_VERSION, ...msg };
}
