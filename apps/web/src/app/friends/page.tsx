'use client';

/**
 * Everyone you are not square with, netted across every group you share.
 *
 * The `waves_people_i_owe` RPC does the netting server-side — one row per person
 * per currency — because "what do I owe Priya, all told" spans groups and can't
 * be added up from any single one. Per currency and never across: a net that
 * mixed rupees and dollars would be money in no currency at all (ADR-004).
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import type { PersonBalanceRow } from '@waves/api-client';

import { AppFrame } from '@/components/AppFrame';
import { Section } from '@/components/Shell';
import { SkeletonRows } from '@/components/Skeleton';
import { waves } from '@/lib/waves';
import { money } from '@/lib/money';
import { plural } from '@/i18n';
import { useStrings } from '@/i18n-context';

interface Person {
  key: string;
  name: string;
  isGhost: boolean;
  groupCount: number;
  onlyGroupId: string | null;
  /** One entry per currency this person and I are out of balance in. */
  nets: { currency: string; net: bigint }[];
}

export default function FriendsPage() {
  return <AppFrame current={Section.Friends}>{({ query }) => <Friends query={query} />}</AppFrame>;
}

function Friends({ query }: { query: string }) {
  const { t, locale } = useStrings();
  const [rows, setRows] = useState<PersonBalanceRow[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const people = await waves.peopleBalances();
        if (active) setRows(people);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const people = useMemo(() => groupByPerson(rows), [rows]);

  const q = query.trim().toLowerCase();
  const shown = q ? people.filter((person) => person.name.toLowerCase().includes(q)) : people;

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <h1>{t.friends.title}</h1>
        </div>

        <section className="panel">
          {loading ? (
            <SkeletonRows rows={6} />
          ) : shown.length === 0 ? (
            <p className="muted">{t.friends.empty}</p>
          ) : (
            <div className="list">
              {shown.map((person) => (
                <div key={person.key} className="item" style={{ cursor: 'default' }}>
                  <span className="avatar" aria-hidden style={{ width: 38, height: 38 }}>
                    {person.name.trim().charAt(0).toUpperCase() || '🙂'}
                  </span>
                  <span className="grow">
                    <span className="title">{person.name}</span>
                    <span className="meta">
                      {plural(locale, person.groupCount, t.friends.inGroups)}
                    </span>
                  </span>
                  <span
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'flex-end',
                      gap: 2,
                    }}
                  >
                    {person.nets.map((row) => {
                      // Positive: they owe you. Negative: you owe them.
                      const owed = row.net > 0n;
                      return (
                        <span key={row.currency} className={`amount ${owed ? 'pos' : 'neg'}`}>
                          {money(row.net < 0n ? -row.net : row.net, row.currency, locale)}
                          <span className="faint" style={{ marginInlineStart: 6, fontWeight: 500 }}>
                            {owed ? t.friends.owesYou : t.friends.youOwe}
                          </span>
                        </span>
                      );
                    })}
                    <Link
                      className="btn soft"
                      href={person.onlyGroupId ? `/settle?group=${person.onlyGroupId}` : '/settle'}
                      style={{ marginTop: 4 }}
                    >
                      {t.friends.settleUp}
                    </Link>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
      <aside className="detail" />
    </div>
  );
}

/** One block per person, gathering their currencies; drops any that netted to zero. */
function groupByPerson(rows: readonly PersonBalanceRow[]): Person[] {
  const byPerson = new Map<string, Person>();
  for (const row of rows) {
    const net = BigInt(row.net);
    if (net === 0n) continue;
    let person = byPerson.get(row.person_key);
    if (!person) {
      person = {
        key: row.person_key,
        name: row.display_name,
        isGhost: row.is_ghost,
        groupCount: row.group_count,
        onlyGroupId: row.only_group_id,
        nets: [],
      };
      byPerson.set(row.person_key, person);
    }
    person.nets.push({ currency: row.currency, net });
  }
  return [...byPerson.values()];
}
