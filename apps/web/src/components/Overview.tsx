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
} from '@baaki/api-client';
import { totalsByCurrency, type CurrencyTotals } from '@baaki/core';

import { baaki } from '@/lib/baaki';
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
          baaki.myGroups(),
          baaki.myBalances(profileId),
          baaki.membersByGroup(),
          baaki.recentActivity(40),
          baaki.pendingSettlements(),
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
    return (
      <div className="app-body">
        <div className="app-main">
          <p className="muted">{t.dash.loading}</p>
        </div>
        <aside className="detail" />
      </div>
    );
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

        <div className="stat-grid">
          <StatCard
            tint="tint-mint"
            icon="📈"
            label={t.dash.youreOwed}
            entries={overall
              .filter((e) => e.owed > 0n)
              .map((e) => ({ currency: e.currency, amount: e.owed }))}
            locale={locale}
            emptyLabel={t.dash.allSettled}
            moreForms={t.dash.moreCurrencies}
          />
          <StatCard
            tint="tint-rose"
            icon="📉"
            label={t.dash.youOwe}
            entries={overall
              .filter((e) => e.owing > 0n)
              .map((e) => ({ currency: e.currency, amount: e.owing }))}
            locale={locale}
            emptyLabel={t.dash.allSettled}
            moreForms={t.dash.moreCurrencies}
          />
          <StatCard
            tint="tint-blue"
            icon="⚖️"
            label={t.dash.net}
            entries={overall.map((e) => ({ currency: e.currency, amount: e.net }))}
            locale={locale}
            signed
            emptyLabel={t.dash.allSettled}
            moreForms={t.dash.moreCurrencies}
          />
          <div className="stat tint-lilac">
            <div className="stat-top">
              <span className="stat-badge" aria-hidden>
                👥
              </span>
              {t.dash.activeGroups}
            </div>
            <div className="stat-value">{groups.length}</div>
          </div>
        </div>

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
                const top = entry.totals[0] ?? null;
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
                        {entry.pending ? ' · •' : ''}
                      </span>
                    </span>
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
              {filteredActivity.slice(0, 12).map((entry) => (
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
          yourNetLabel={t.dash.yourNet}
          openLabel={t.dash.openGroup}
          currencyLabel={t.dash.currencyLabel}
          settledLabel={t.dash.settledUp}
        />
      </aside>
    </div>
  );
}

function StatCard({
  tint,
  icon,
  label,
  entries,
  locale,
  emptyLabel,
  moreForms,
  signed = false,
}: {
  tint: string;
  icon: string;
  label: string;
  entries: { currency: string; amount: bigint }[];
  locale: string;
  emptyLabel: string;
  moreForms: PluralForms;
  signed?: boolean;
}) {
  const shown = entries.filter((e) => e.amount !== 0n);
  const top = shown[0] ?? null;
  const rest = shown.length - 1;

  return (
    <div className={`stat ${tint}`}>
      <div className="stat-top">
        <span className="stat-badge" aria-hidden>
          {icon}
        </span>
        {label}
      </div>
      {top ? (
        <>
          <div className="stat-value">
            {signed && top.amount < 0n ? '−' : ''}
            {money(top.amount < 0n ? -top.amount : top.amount, top.currency, locale)}
          </div>
          {rest > 0 ? <div className="stat-extra">{plural(locale, rest, moreForms)}</div> : null}
        </>
      ) : (
        <div className="stat-value" style={{ fontSize: 18, opacity: 0.7 }}>
          {emptyLabel}
        </div>
      )}
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
  yourNetLabel: string;
  openLabel: string;
  currencyLabel: string;
  settledLabel: string;
}) {
  if (!entry) {
    return <p className="detail-empty">{selectHint}</p>;
  }
  const label = groupLabel(entry.group, entry.members, profileId);
  const top = entry.totals[0] ?? null;

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
