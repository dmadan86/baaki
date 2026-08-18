'use client';

/**
 * Everything that has happened across every group I am in, newest first.
 *
 * The overview shows the last dozen; this is the whole feed. It reads the same
 * `activity_log` rows the phone does and words each one from the reader's point
 * of view through the shared `describeActivity` (mirrors mobile), so the browser
 * and the app never narrate the same event two different ways. RLS decides which
 * rows come back — there is no group filter here to disagree with it (ADR-013).
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';

import type { ActivityGroup, ActivityRow } from '@waves/api-client';

import { AppFrame } from '@/components/AppFrame';
import { Section } from '@/components/Shell';
import { SkeletonRows } from '@/components/Skeleton';
import { baaki } from '@/lib/baaki';
import { describeActivity, verbEmoji } from '@/lib/activity';
import { useStrings } from '@/i18n-context';

type FeedRow = ActivityRow & { group: ActivityGroup | null };

export default function ActivityPage() {
  return (
    <AppFrame current={Section.Activity}>
      {({ profileId, query }) => <ActivityFeed profileId={profileId} query={query} />}
    </AppFrame>
  );
}

function ActivityFeed({ profileId, query }: { profileId: string; query: string }) {
  const { t } = useStrings();
  const [rows, setRows] = useState<FeedRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const feed = await baaki.recentActivity(200);
        if (active) setRows(feed);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const q = query.trim().toLowerCase();
  const shown = q
    ? rows.filter((entry) => describeActivity(entry, profileId).toLowerCase().includes(q))
    : rows;

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <h1>{t.activity.title}</h1>
        </div>

        <section className="panel">
          {loading ? (
            <SkeletonRows rows={7} amount={false} />
          ) : shown.length === 0 ? (
            <p className="muted">{t.activity.empty}</p>
          ) : (
            <div className="list">
              {shown.map((entry) => {
                const line = (
                  <>
                    <span className="tile-emoji" aria-hidden>
                      {verbEmoji(entry.verb)}
                    </span>
                    <span className="grow">
                      <span className="title" style={{ fontWeight: 500, whiteSpace: 'normal' }}>
                        {describeActivity(entry, profileId)}
                      </span>
                      <span className="meta">{entry.group?.name?.trim() ?? ''}</span>
                    </span>
                  </>
                );
                // A row about an expense links to it; the rest are not clickable.
                return entry.object_type === 'expense' && entry.object_id ? (
                  <Link
                    key={entry.id}
                    className="item"
                    href={`/g/${entry.group_id}/expense/${entry.object_id}`}
                  >
                    {line}
                  </Link>
                ) : (
                  <div key={entry.id} className="item" style={{ cursor: 'default' }}>
                    {line}
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
      <aside className="detail" />
    </div>
  );
}
