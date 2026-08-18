'use client';

/**
 * The inbox — everything Baaki has told this person, whether or not a push ever
 * reached a device (TDR §7.1 calls it the ledger of record). Which rows are
 * whose is the `notifications_select_own` policy's call, not a filter here.
 *
 * Reads are live; the only writes are marking things read, which goes through
 * the same `baaki_mark_notifications_read` RPC the phone uses.
 */

import { useEffect, useState } from 'react';

import type { NotificationRow } from '@waves/api-client';

import { AppFrame } from '@/components/AppFrame';
import { Section } from '@/components/Shell';
import { SkeletonRows } from '@/components/Skeleton';
import { baaki } from '@/lib/baaki';
import { useStrings } from '@/i18n-context';

export default function InboxPage() {
  return <AppFrame current={Section.Inbox}>{() => <Inbox />}</AppFrame>;
}

function Inbox() {
  const { t } = useStrings();
  const [rows, setRows] = useState<NotificationRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const inbox = await baaki.notifications(100);
        if (active) setRows(inbox);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const unread = rows.filter((row) => !row.read_at);

  async function markRead(ids: string[]) {
    if (ids.length === 0) return;
    const now = new Date().toISOString();
    const before = new Map(
      rows.filter((row) => ids.includes(row.id)).map((row) => [row.id, row.read_at]),
    );
    // Every targeted row is already read — nothing to do, and no RPC to fire.
    if ([...before.values()].every((read) => read !== null)) return;
    // Optimistic: the RPC is the authority, but the inbox should not wait a
    // round-trip to stop shouting at somebody who has read the thing.
    setRows((prev) =>
      prev.map((row) => (ids.includes(row.id) ? { ...row, read_at: row.read_at ?? now } : row)),
    );
    try {
      await baaki.markNotificationsRead(ids);
    } catch {
      // Put the dots back if the server refused — better than a lie. Restore
      // each row to exactly what it was, so an already-read row stays read.
      setRows((prev) =>
        prev.map((row) =>
          before.has(row.id) ? { ...row, read_at: before.get(row.id) ?? null } : row,
        ),
      );
    }
  }

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <h1>{t.inbox.title}</h1>
          {unread.length > 0 ? (
            <button
              type="button"
              className="btn soft"
              onClick={() => void markRead(unread.map((row) => row.id))}
            >
              {t.inbox.markAllRead}
            </button>
          ) : null}
        </div>

        <section className="panel">
          {loading ? (
            <SkeletonRows rows={7} amount={false} />
          ) : error ? (
            <p className="error">{error}</p>
          ) : rows.length === 0 ? (
            <p className="muted">{t.inbox.empty}</p>
          ) : (
            <div className="list">
              {rows.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  className="item"
                  onClick={() => void markRead([row.id])}
                  style={{ textAlign: 'start', width: '100%' }}
                >
                  <span className="tile-emoji" aria-hidden>
                    {row.read_at ? '📭' : '📬'}
                  </span>
                  <span className="grow">
                    <span
                      className="title"
                      style={{ whiteSpace: 'normal', fontWeight: row.read_at ? 500 : 700 }}
                    >
                      {row.title}
                    </span>
                    <span className="meta" style={{ whiteSpace: 'normal' }}>
                      {row.body}
                    </span>
                  </span>
                  {row.read_at ? null : <span className="unread-dot" aria-hidden />}
                </button>
              ))}
            </div>
          )}
        </section>
      </div>
      <aside className="detail" />
    </div>
  );
}
