'use client';

/**
 * The dashboard — the whole ledger at a glance, styled after the reference.
 *
 * Every number here is the server's, read under the reader's own session
 * (ADR-013): "my groups" is the groups RLS returns, "my balance" is the row
 * for my member in each. Balances are totalled per currency and never across
 * them (`totalsByCurrency`, ADR-004) — a mixed total would be money in no
 * currency at all.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

import {
  groupLabel,
  memberName,
  type ActivityGroup,
  type ActivityRow,
  type BalanceRow,
  type GroupRow,
  type MemberRow,
} from '@waves/api-client';
import { totalsByCurrency, type CurrencyTotals } from '@waves/core';

import { waves } from '@/lib/waves';
import { SkeletonRows } from '@/components/Skeleton';
import { money } from '@/lib/money';
import { describeActivity, verbEmoji } from '@/lib/activity';
import { plural, type PluralForms } from '@/i18n';
import { useStrings } from '@/i18n-context';

interface GroupNet {
  group: GroupRow;
  /** My net per currency in this group; usually one entry. */
  totals: CurrencyTotals[];
  members: MemberRow[];
  pending: boolean;
}

export function Overview({ profileId, query }: { profileId: string; query: string }) {
  const { t, locale } = useStrings();

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [myBalances, setMyBalances] = useState<BalanceRow[]>([]);
  const [membersByGroup, setMembersByGroup] = useState<Map<string, MemberRow[]>>(new Map());
  const [activity, setActivity] = useState<(ActivityRow & { group: ActivityGroup | null })[]>([]);
  const [pendingGroups, setPendingGroups] = useState<Set<string>>(new Set());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [g, b, m, a, pending] = await Promise.all([
          waves.myGroups(),
          waves.myBalances(profileId),
          waves.membersByGroup(),
          waves.recentActivity(40),
          waves.pendingSettlements(),
        ]);
        if (!active) return;
        setGroups(g);
        setMyBalances(b);
        setMembersByGroup(m);
        setActivity(a);
        setPendingGroups(new Set(pending.map((row) => row.group_id)));
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [profileId]);

  // My balance per group, per currency — the number the group row shows.
  const byGroup = useMemo(() => {
    const map = new Map<string, BalanceRow[]>();
    for (const row of myBalances) {
      const list = map.get(row.group_id);
      if (list) list.push(row);
      else map.set(row.group_id, [row]);
    }
    return map;
  }, [myBalances]);

  const groupNets = useMemo<GroupNet[]>(() => {
    return groups.map((group) => {
      const rows = byGroup.get(group.id) ?? [];
      const totals = totalsByCurrency(
        rows.map((row) => [row.currency, BigInt(row.balance)] as const),
      );
      return {
        group,
        totals,
        members: membersByGroup.get(group.id) ?? [],
        pending: pendingGroups.has(group.id),
      };
    });
  }, [groups, byGroup, membersByGroup, pendingGroups]);

  // Overall, totalled per currency and never across them.
  const overall = useMemo(
    () => totalsByCurrency(myBalances.map((row) => [row.currency, BigInt(row.balance)] as const)),
    [myBalances],
  );

  // The hero's single answer: the currency the reader is furthest from square
  // in leads, the rest fold into "+N more". Net, never a sum across currencies
  // (ADR-004) — the largest |net| just decides which one gets the big line.
  const heroTotals = useMemo(() => {
    const abs = (n: bigint) => (n < 0n ? -n : n);
    return overall
      .filter((e) => e.net !== 0n)
      .sort((a, b) => (abs(a.net) > abs(b.net) ? -1 : abs(a.net) < abs(b.net) ? 1 : 0));
  }, [overall]);
  const heroTop = heroTotals[0] ?? null;
  const heroRest = Math.max(heroTotals.length - 1, 0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return groupNets;
    return groupNets.filter((entry) =>
      groupLabel(entry.group, entry.members, profileId).toLowerCase().includes(q),
    );
  }, [groupNets, query, profileId]);

  const filteredActivity = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return activity;
    return activity.filter((entry) => describeActivity(entry, profileId).toLowerCase().includes(q));
  }, [activity, query, profileId]);

  // Effective selection: the clicked group if it is still present, else the
  // first. Derived rather than synced in an effect, so there is no cascading
  // render and no moment where the panel points at a group that has gone.
  const effectiveId =
    selectedId && groupNets.some((entry) => entry.group.id === selectedId)
      ? selectedId
      : (groupNets[0]?.group.id ?? null);
  const selected = groupNets.find((entry) => entry.group.id === effectiveId) ?? null;

  if (loading) {
    return <OverviewSkeleton />;
  }

  if (error) {
    return (
      <div className="app-body">
        <div className="app-main">
          <p className="error">{error}</p>
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
            <h1>{t.dash.overviewTitle}</h1>
            <div className="sub">{plural(locale, groups.length, t.dash.groupsCount)}</div>
          </div>
        </div>

        {/* One dominant answer instead of four boxes of equal weight: are you
            up, down, or square. The per-group rows below carry the detail. */}
        {groups.length > 0 ? (
          heroTop ? (
            <section className={`hero ${heroTop.net > 0n ? 'hero-owed' : 'hero-owe'}`}>
              <div className="hero-label">
                {heroTop.net > 0n ? t.dash.youGetBack : t.dash.youNeedToPay}
              </div>
              <div className="hero-amount">
                {money(heroTop.net < 0n ? -heroTop.net : heroTop.net, heroTop.currency, locale)}
              </div>
              {heroRest > 0 ? (
                <div className="hero-extra">{plural(locale, heroRest, t.dash.moreCurrencies)}</div>
              ) : null}
            </section>
          ) : (
            <section className="hero hero-flat">
              <div className="hero-amount hero-flat-line">🎉 {t.dash.allSettled}</div>
            </section>
          )
        ) : null}

        <section className="panel">
          <div className="panel-head">
            <h2>{t.dash.yourGroups}</h2>
          </div>
          {filtered.length === 0 ? (
            <p className="muted">{t.dash.noGroups}</p>
          ) : (
            <div className="list">
              {filtered.map((entry) => {
                const label = groupLabel(entry.group, entry.members, profileId);
                // Show a currency the user is not square in first, so a group
                // owing in one currency never reads as settled by the other.
                const nonZero = entry.totals.filter((total) => total.net !== 0n);
                const top = nonZero[0] ?? entry.totals[0] ?? null;
                const moreCurrencies = Math.max(nonZero.length - 1, 0);
                return (
                  <button
                    key={entry.group.id}
                    type="button"
                    className="item"
                    aria-pressed={entry.group.id === effectiveId}
                    onClick={() => setSelectedId(entry.group.id)}
                  >
                    <span className="tile-emoji" aria-hidden>
                      {entry.group.cover_emoji ?? '💫'}
                    </span>
                    <span className="grow">
                      <span className="title">{label}</span>
                      <span className="meta">
                        {plural(locale, entry.members.length, t.dash.membersCount)}
                        {moreCurrencies > 0
                          ? ` · ${plural(locale, moreCurrencies, t.dash.moreCurrencies)}`
                          : ''}
                      </span>
                    </span>
                    {entry.pending ? (
                      <span className="unread-dot" role="img" aria-label={t.settle.pendingHead} />
                    ) : null}
                    <NetAmount total={top} locale={locale} settledLabel={t.dash.settledUp} />
                  </button>
                );
              })}
            </div>
          )}
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{t.dash.recentActivity}</h2>
          </div>
          {filteredActivity.length === 0 ? (
            <p className="muted">{t.dash.noActivity}</p>
          ) : (
            <div className="list">
              {filteredActivity.slice(0, 6).map((entry) => (
                <div key={entry.id} className="item" style={{ cursor: 'default' }}>
                  <span className="tile-emoji" aria-hidden>
                    {verbEmoji(entry.verb)}
                  </span>
                  <span className="grow">
                    <span className="title" style={{ fontWeight: 500, whiteSpace: 'normal' }}>
                      {describeActivity(entry, profileId)}
                    </span>
                    <span className="meta">
                      {entry.group?.name?.trim() ? entry.group.name : ''}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>

      <aside className="detail">
        <DetailPanel
          entry={selected}
          profileId={profileId}
          locale={locale}
          selectHint={t.dash.selectGroupHint}
          membersForms={t.dash.membersCount}
          moreCurrenciesForms={t.dash.moreCurrencies}
          yourNetLabel={t.dash.yourNet}
          openLabel={t.dash.openGroup}
          currencyLabel={t.dash.currencyLabel}
          settledLabel={t.dash.settledUp}
        />
      </aside>
    </div>
  );
}

/**
 * The dashboard's shape held open while the numbers load — same grid, same
 * card sizes, so the real content drops in without the layout jumping. Purely
 * decorative, so it's hidden from the accessibility tree.
 */
function OverviewSkeleton() {
  return (
    <div className="app-body" aria-hidden>
      <div className="app-main">
        <div className="page-head">
          <span className="sk sk-sub" />
        </div>

        <div className="hero">
          <span className="sk sk-line" style={{ width: 96 }} />
          <span className="sk sk-line" style={{ height: 38, width: 190, marginTop: 6 }} />
        </div>

        {[0, 1].map((panel) => (
          <section key={panel} className="panel">
            <div className="panel-head">
              <span className="sk sk-head" />
            </div>
            <SkeletonRows rows={3} />
          </section>
        ))}
      </div>

      <aside className="detail">
        <div className="detail-hero">
          <span className="sk sk-avatar" />
          <span className="sk sk-line" style={{ width: 130, margin: '0 auto' }} />
        </div>
        {[0, 1].map((f) => (
          <div key={f} className="detail-field">
            <span className="sk sk-line" style={{ width: 70 }} />
            <span className="sk sk-line" style={{ width: 90 }} />
          </div>
        ))}
      </aside>
    </div>
  );
}

function NetAmount({
  total,
  locale,
  settledLabel,
}: {
  total: CurrencyTotals | null;
  locale: string;
  settledLabel: string;
}) {
  if (!total || total.net === 0n) {
    return <span className="amount zero">{settledLabel}</span>;
  }
  const positive = total.net > 0n;
  return (
    <span className={`amount ${positive ? 'pos' : 'neg'}`}>
      {positive ? '+' : '−'}
      {money(total.net < 0n ? -total.net : total.net, total.currency, locale)}
    </span>
  );
}

function DetailPanel({
  entry,
  profileId,
  locale,
  selectHint,
  membersForms,
  moreCurrenciesForms,
  yourNetLabel,
  openLabel,
  currencyLabel,
  settledLabel,
}: {
  entry: GroupNet | null;
  profileId: string;
  locale: string;
  selectHint: string;
  membersForms: PluralForms;
  moreCurrenciesForms: PluralForms;
  yourNetLabel: string;
  openLabel: string;
  currencyLabel: string;
  settledLabel: string;
}) {
  if (!entry) {
    return <p className="detail-empty">{selectHint}</p>;
  }
  const label = groupLabel(entry.group, entry.members, profileId);
  // A currency the user still owes in leads, so the net line never claims the
  // group is settled while another currency is outstanding.
  const nonZero = entry.totals.filter((total) => total.net !== 0n);
  const top = nonZero[0] ?? entry.totals[0] ?? null;
  const moreCurrencies = Math.max(nonZero.length - 1, 0);

  return (
    <>
      <div className="detail-hero">
        <div className="avatar" aria-hidden>
          {entry.group.cover_emoji ?? '💫'}
        </div>
        <h3>{label}</h3>
        <div className="role">{plural(locale, entry.members.length, membersForms)}</div>
      </div>

      <div className="detail-field">
        <span className="k">{yourNetLabel}</span>
        <span className="v">
          <NetAmount total={top} locale={locale} settledLabel={settledLabel} />
          {moreCurrencies > 0 ? (
            <span className="meta" style={{ marginInlineStart: 6 }}>
              {plural(locale, moreCurrencies, moreCurrenciesForms)}
            </span>
          ) : null}
        </span>
      </div>
      <div className="detail-field">
        <span className="k">{currencyLabel}</span>
        <span className="v">{entry.group.default_currency}</span>
      </div>

      <div className="list" style={{ marginTop: 8 }}>
        {entry.members.slice(0, 8).map((member) => (
          <div key={member.id} className="detail-field">
            <span className="v" style={{ fontWeight: 500 }}>
              {memberName(member, profileId)}
            </span>
          </div>
        ))}
      </div>

      <Link className="btn block" href={`/g/${entry.group.id}`} style={{ marginTop: 14 }}>
        {openLabel}
      </Link>
    </>
  );
}
