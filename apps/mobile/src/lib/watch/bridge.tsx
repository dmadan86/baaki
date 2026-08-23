/**
 * The phone half of the watch companion.
 *
 * Mounted once near the app root, this listens for intents the paired watch
 * sends (quick-add, voice-add, request-recent) and services them through the
 * code the app already uses — the offline capture queue and the pure voice
 * parser — then relays results back. The watch holds no ledger logic; this is
 * where its taps become real writes. See `@waves/core`'s relay contract.
 *
 * v1 services intents while the app is running or backgrounded-reachable;
 * headless delivery (phone app fully killed) is a later hardening that belongs
 * in the native transport, not here.
 */

import { useCallback, useEffect, useRef, type ReactNode } from 'react';

import {
  coerceRecentCount,
  format as formatMoney,
  money as toMoney,
  parseWatchToPhone,
  type WatchRecentItem,
} from '@waves/core';

import { describeActivity, parseMoney, relativeTime } from '@/data/activity';
import {
  useCreateCapture,
  useGroups,
  useRecentActivity,
  type RecentActivityRow,
} from '@/data/hooks';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { useDefaultCurrency } from '@/lib/currency';
import { useRecentCount } from '@/lib/recentCount';
import { parseVoiceExpenses, type VoiceGroupRef } from '@/lib/voiceExpense';
import { onWatchMessage, sendToWatch, watchAvailable } from './nativeModule';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** Local calendar date (YYYY-MM-DD) — not UTC, so an evening expense keeps its day. */
function localDate(now: number): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * Turn the recent-activity feed into the flat rows the watch renders. Pure and
 * exported so it can be tested without a device: money and time are formatted
 * here (on the phone) so the watch needs no currency tables or locale data.
 */
export function buildRecentItems(
  rows: readonly RecentActivityRow[],
  count: number,
  opts: {
    myProfileId: string | null;
    locale: string;
    fallbackCurrency: string;
    someoneLabel: string;
    personalLabel: string;
    now: number;
  },
): WatchRecentItem[] {
  return rows.slice(0, count).map((row) => {
    const parsed = parseMoney(row.payload, opts.fallbackCurrency);
    return {
      title: describeActivity(row, opts.myProfileId, null, opts.someoneLabel),
      subtitle: row.group?.name ?? opts.personalLabel,
      amountText: parsed
        ? formatMoney(toMoney(parsed.amount, parsed.currency), {
            locale: opts.locale,
            compactFraction: true,
          })
        : '',
      whenText: relativeTime(opts.locale, row.created_at, opts.now),
    };
  });
}

export function WatchBridgeProvider({ children }: { children?: ReactNode }) {
  const createCapture = useCreateCapture();
  const recent = useRecentActivity();
  const groups = useGroups();
  const { count } = useRecentCount();
  const { session } = useAuth();
  const defaultCurrency = useDefaultCurrency();
  const { t, locale } = useStrings();

  // The message handler is bound once; it reads the latest of everything through
  // this ref so a new recent list or a changed setting never re-subscribes.
  const stateRef = useRef({
    recent,
    groups: groups.data ?? [],
    count,
    myProfileId: session?.user?.id ?? null,
    defaultCurrency,
    locale,
    someone: t.misc.someone,
    personal: t.captures.unassigned,
  });
  const createRef = useRef(createCapture);
  /** The last recent payload sent, so an unchanged list is not re-sent. */
  const lastRecentRef = useRef<string | null>(null);

  // Refs are written in an effect, never during render (react-hooks/refs): the
  // once-bound message handler reads the latest of everything through them.
  useEffect(() => {
    stateRef.current = {
      recent,
      groups: groups.data ?? [],
      count,
      myProfileId: session?.user?.id ?? null,
      defaultCurrency,
      locale,
      someone: t.misc.someone,
      personal: t.captures.unassigned,
    };
    createRef.current = createCapture;
  });

  /**
   * Send the watch the current recent list.
   *
   * `force` is for a watch that asked (`requestRecent`): it must always get an
   * answer, because a freshly launched watch has an empty list of its own and
   * would otherwise be told nothing when the payload happens to match what the
   * last watch session was sent. The automatic push deduplicates instead, so an
   * unrelated sync tick — the mirror changes often — does not spend a
   * WatchConnectivity message re-sending rows the watch already shows.
   */
  const relayRecent = useCallback((n: number, opts?: { force?: boolean }) => {
    if (!watchAvailable()) return;
    const s = stateRef.current;
    const items = buildRecentItems(s.recent, n, {
      myProfileId: s.myProfileId,
      locale: s.locale,
      fallbackCurrency: s.defaultCurrency,
      someoneLabel: s.someone,
      personalLabel: s.personal,
      now: Date.now(),
    });
    const encoded = JSON.stringify(items);
    if (!opts?.force && encoded === lastRecentRef.current) return;
    lastRecentRef.current = encoded;
    sendToWatch({ t: 'recent', items });
  }, []);

  /**
   * Relay the list when it actually changes, rather than when a write is made.
   *
   * `useSync`'s `mutate` only enqueues — it does not touch the mirror — and
   * `useRecentActivity` derives purely from the mirror, so relaying straight
   * after `await mutateAsync` sent the watch the list from *before* the write
   * every time: the expense just added from the wrist was the one row it could
   * never contain. Waiting for the mirror to change means the watch is told once
   * the write has actually landed, whenever that is.
   */
  useEffect(() => {
    relayRecent(count);
    // The two label strings rather than the whole `t` object, which is a fresh
    // identity each render and would run this on every one.
  }, [
    relayRecent,
    recent,
    count,
    defaultCurrency,
    locale,
    session?.user?.id,
    t.misc.someone,
    t.captures.unassigned,
  ]);

  // Subscribe once. Everything the handler needs comes from the refs above.
  useEffect(() => {
    if (!watchAvailable()) return;

    const unsubscribe = onWatchMessage((raw) => {
      const msg = parseWatchToPhone(raw);
      if (!msg) return;
      void (async () => {
        const s = stateRef.current;
        try {
          switch (msg.t) {
            case 'quickAdd': {
              await createRef.current.mutateAsync({
                // The watch's per-intent id becomes the capture id, so a
                // transport retry of the same tap is a no-op upsert, not a dup.
                captureId: msg.id,
                amount: BigInt(msg.amountMinor),
                currency: msg.currency,
                description: msg.note,
                expenseDate: localDate(Date.now()),
                rawText: msg.note || null,
              });
              // No recent relay here: the write is only queued at this point,
              // so the list would still be the pre-write one. The effect above
              // sends it when the mirror actually changes.
              sendToWatch({ t: 'ack', ok: true });
              break;
            }
            case 'voiceAdd': {
              const refs: VoiceGroupRef[] = s.groups.map((g) => ({ id: g.id, name: g.name }));
              const result = parseVoiceExpenses(msg.transcript, refs);
              const items = result.items.filter((item) => item.amountMinor > 0n);
              if (items.length === 0) {
                sendToWatch({ t: 'ack', ok: false, error: 'no-amount' });
                break;
              }
              // Always land as unassigned captures — the safe group-less path;
              // the person tags a destination later on the phone. Group-target
              // routing from the wrist is a later refinement.
              //
              // The single-expense case (the common one) reuses the watch id as
              // the capture id, so a replayed utterance is idempotent. A
              // multi-expense utterance keeps server-generated ids — a replay of
              // that rarer case can duplicate, a documented v1 limitation.
              const single = items.length === 1;
              for (const item of items) {
                await createRef.current.mutateAsync({
                  captureId: single ? msg.id : undefined,
                  amount: item.amountMinor,
                  currency: item.currency ?? s.defaultCurrency,
                  description: item.note,
                  expenseDate: localDate(Date.now()),
                  rawText: msg.transcript,
                });
              }
              sendToWatch({ t: 'ack', ok: true });
              break;
            }
            case 'requestRecent':
              relayRecent(coerceRecentCount(msg.count), { force: true });
              break;
            case 'notifAction':
              // Wired in the notification-actions phase; acknowledge for now.
              sendToWatch({ t: 'ack', ok: false, error: 'unsupported' });
              break;
          }
        } catch {
          sendToWatch({ t: 'ack', ok: false, error: 'failed' });
        }
      })();
    });

    return unsubscribe;
    // `relayRecent` is stable, so this still subscribes exactly once.
  }, [relayRecent]);

  // Keep the watch's copy of the settings (list size + the currency a quick-add
  // is booked in) in step with the phone.
  useEffect(() => {
    if (!watchAvailable()) return;
    sendToWatch({
      t: 'settings',
      recentCount: coerceRecentCount(count),
      currency: defaultCurrency,
    });
  }, [count, defaultCurrency]);

  return <>{children ?? null}</>;
}
