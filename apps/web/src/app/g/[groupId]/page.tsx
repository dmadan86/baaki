'use client';

/**
 * One group, in the full web client.
 *
 * The same balances the phone shows, computed by @baaki/core from the same
 * rows (TDR §1): a guest's browser and the payer's phone cannot disagree about
 * who owes what. Reskinned into the dashboard frame — panels for where everyone
 * stands, who pays whom, and the recent expenses, with the group summary and
 * the way in to add another on the right.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';

import {
  computeLedger,
  nameOf,
  type Expense,
  type Group,
  type Member,
  type Settlement,
} from '@baaki/api-client';

import { AppFrame } from '@/components/AppFrame';
import { baaki } from '@/lib/baaki';
import { money } from '@/lib/money';
import { plural } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function GroupPage() {
  return (
    <AppFrame current="groups">
      {({ profileId, query }) => <GroupDetail profileId={profileId} query={query} />}
    </AppFrame>
  );
}

function GroupDetail({ profileId, query }: { profileId: string; query: string }) {
  const { t, locale } = useStrings();
  const params = useParams<{ groupId: string }>();
  const groupId = params.groupId;

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [g, m, e, s] = await Promise.all([
          baaki.group(groupId),
          baaki.members(groupId),
          baaki.expenses(groupId),
          baaki.settlements(groupId),
        ]);
        if (!active) return;
        setGroup(g);
        setMembers(m);
        setExpenses(e);
        setSettlements(s);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [groupId]);

  if (loading) {
    return (
      <div className="app-body">
        <div className="app-main">
          <p className="muted">{t.group.loading}</p>
        </div>
        <aside className="detail" />
      </div>
    );
  }

  // RLS answers "not yours" with no rows rather than an error.
  if (!group) {
    return (
      <div className="app-body">
        <div className="app-main">
          <div className="panel">
            <h2>{t.group.notYours}</h2>
            <p className="muted">{error ?? t.group.notYoursBody}</p>
          </div>
        </div>
        <aside className="detail" />
      </div>
    );
  }

  const currency = group.default_currency;
  const ledger = computeLedger(expenses, settlements, currency);
  const byId = new Map(members.map((member) => [member.id, member]));
  const live = expenses.filter((expense) => !expense.deleted_at && expense.currentVersion);

  const q = query.trim().toLowerCase();
  const shownExpenses = q
    ? live.filter((e) => e.currentVersion?.description.toLowerCase().includes(q))
    : live;

  const myMember = members.find((m) => m.profile_id === profileId) ?? null;
  const myNet = myMember ? (ledger.balances.get(myMember.id) ?? 0n) : 0n;

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <div>
            <h1>
              {group.cover_emoji ? `${group.cover_emoji} ` : ''}
              {group.name?.trim() || t.group.yourGroup}
            </h1>
            <div className="sub">
              {plural(locale, members.length, t.group.peopleCount)} ·{' '}
              {plural(locale, live.length, t.group.expenseCount)}
            </div>
          </div>
          <Link className="btn" href={`/g/${groupId}/add`}>
            {t.group.addAnExpense}
          </Link>
        </div>

        <section className="panel">
          <div className="panel-head">
            <h2>{t.group.whereEveryoneStands}</h2>
          </div>
          <div className="list">
            {members.map((member) => {
              const net = ledger.balances.get(member.id) ?? 0n;
              const cls = net > 0n ? 'pos' : net < 0n ? 'neg' : 'zero';
              return (
                <div key={member.id} className="item" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title">{nameOf(member)}</span>
                  </span>
                  <span className={`amount ${cls}`}>
                    {net === 0n
                      ? t.group.settledUp
                      : `${net > 0n ? '+' : '−'}${money(net < 0n ? -net : net, currency, locale)}`}
                  </span>
                </div>
              );
            })}
          </div>
        </section>

        {ledger.transfers.length > 0 ? (
          <section className="panel">
            <div className="panel-head">
              <h2>{t.group.whoPaysWhom}</h2>
            </div>
            <p className="faint" style={{ marginTop: -6, marginBottom: 10 }}>
              {t.group.whoPaysWhomNote}
            </p>
            <div className="list">
              {ledger.transfers.map((transfer, index) => (
                <div key={index} className="item" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title" style={{ fontWeight: 500 }}>
                      {nameOf(byId.get(transfer.from) ?? fallback(transfer.from))} →{' '}
                      {nameOf(byId.get(transfer.to) ?? fallback(transfer.to))}
                    </span>
                  </span>
                  <span className="amount">{money(transfer.amount, transfer.currency, locale)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-head">
            <h2>{t.group.recent}</h2>
          </div>
          {shownExpenses.length === 0 ? (
            <p className="muted">{t.dash.noActivity}</p>
          ) : (
            <div className="list">
              {shownExpenses.slice(0, 30).map((expense) => {
                const version = expense.currentVersion;
                if (!version) return null;
                return (
                  <div key={expense.id} className="item" style={{ cursor: 'default' }}>
                    <span className="grow">
                      <span className="title">{version.description}</span>
                      <span className="meta">{version.expense_date}</span>
                    </span>
                    <span className="amount">
                      {money(BigInt(version.amount), version.currency, locale)}
                    </span>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>

      <aside className="detail">
        <div className="detail-hero">
          <div className="avatar" aria-hidden>
            {group.cover_emoji ?? '💫'}
          </div>
          <h3>{group.name?.trim() || t.group.yourGroup}</h3>
          <div className="role">{plural(locale, members.length, t.group.peopleCount)}</div>
        </div>

        <div className="detail-field">
          <span className="k">{t.dash.yourNet}</span>
          <span className="v">
            <span className={`amount ${myNet > 0n ? 'pos' : myNet < 0n ? 'neg' : 'zero'}`}>
              {myNet === 0n
                ? t.dash.settledUp
                : `${myNet > 0n ? '+' : '−'}${money(myNet < 0n ? -myNet : myNet, currency, locale)}`}
            </span>
          </span>
        </div>
        <div className="detail-field">
          <span className="k">{t.dash.currencyLabel}</span>
          <span className="v">{currency}</span>
        </div>

        <Link className="btn block" href={`/g/${groupId}/add`} style={{ marginTop: 14 }}>
          {t.group.addAnExpense}
        </Link>
      </aside>
    </div>
  );
}

/** A member who has left is still on old expenses; the transfer still names them. */
function fallback(memberId: string): Member {
  return {
    id: memberId,
    group_id: '',
    profile_id: null,
    ghost_name: null,
    left_at: null,
    profile: null,
  };
}
