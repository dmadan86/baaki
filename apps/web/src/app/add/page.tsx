'use client';

/**
 * The global "Add expense" lands here.
 *
 * An expense still belongs to a group, but the reader should not have to open
 * one first to reach the form — that is the friction the roast named. So this
 * route holds the choice, not the dashboard: one group means no choice at all
 * (straight through to its form), several means a short pick, none means there
 * is nothing to add to yet. The form itself is unchanged — this only decides
 * which group's `/g/[id]/add` to open.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';

import { groupLabel, type GroupRow, type MemberRow } from '@waves/api-client';

import { waves } from '@/lib/waves';
import { AppFrame } from '@/components/AppFrame';
import { Section } from '@/components/Shell';
import { SkeletonRows } from '@/components/Skeleton';
import { plural } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function AddPage() {
  return (
    <AppFrame current={Section.Overview}>
      {({ profileId }) => <Picker profileId={profileId} />}
    </AppFrame>
  );
}

function Picker({ profileId }: { profileId: string }) {
  const router = useRouter();
  const { t, locale } = useStrings();

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [membersByGroup, setMembersByGroup] = useState<Map<string, MemberRow[]>>(new Map());
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      // Set when we hand off to a group's form, so the `finally` does not drop
      // the skeleton and flash the picker for the single-group case.
      let forwarding = false;
      try {
        const [g, m] = await Promise.all([waves.myGroups(), waves.membersByGroup()]);
        if (!active) return;
        const only = g.length === 1 ? g[0] : null;
        if (only) {
          forwarding = true;
          router.replace(`/g/${only.id}/add`);
          return;
        }
        setGroups(g);
        setMembersByGroup(m);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active && !forwarding) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [router]);

  if (loading) {
    return (
      <div className="app-body">
        <div className="app-main">
          <div className="page-head">
            <div>
              <h1>{t.dash.addExpense}</h1>
              <div className="sub">{t.dash.addPickGroup}</div>
            </div>
          </div>
          <section className="panel">
            <SkeletonRows rows={4} />
          </section>
        </div>
        <aside className="detail" />
      </div>
    );
  }

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <div>
            <h1>{t.dash.addExpense}</h1>
            <div className="sub">{t.dash.addPickGroup}</div>
          </div>
        </div>

        <section className="panel">
          {error ? (
            <p className="error">{error}</p>
          ) : groups.length === 0 ? (
            <p className="muted">{t.dash.noGroups}</p>
          ) : (
            <div className="list">
              {groups.map((group) => {
                const members = membersByGroup.get(group.id) ?? [];
                return (
                  <Link key={group.id} href={`/g/${group.id}/add`} className="item">
                    <span className="tile-emoji" aria-hidden>
                      {group.cover_emoji ?? '💫'}
                    </span>
                    <span className="grow">
                      <span className="title">{groupLabel(group, members, profileId)}</span>
                      <span className="meta">
                        {plural(locale, members.length, t.dash.membersCount)}
                      </span>
                    </span>
                    <span className="item-go" aria-hidden>
                      →
                    </span>
                  </Link>
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
