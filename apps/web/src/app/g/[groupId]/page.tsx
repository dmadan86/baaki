'use client';

/**
 * The group, in a browser.
 *
 * Deliberately less than the app: balances, who owes whom, the recent
 * expenses, and one way to add another. Everything a guest needs during the
 * trip, and nothing that would need explaining.
 *
 * The balances are computed by @baaki/core from the same rows the app reads,
 * so a guest's browser and the payer's phone cannot disagree about who owes
 * what. If they could, there would be no way to say which one was lying.
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

import { baaki } from '@/lib/baaki';
import { money } from '@/lib/money';
import { plural } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function GroupPage() {
  const params = useParams<{ groupId: string }>();
  const groupId = params.groupId;
  const { t, locale } = useStrings();

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    // Guarded, because navigating away mid-fetch would otherwise write one
    // group's rows into a screen already showing another's.
    let active = true;
    void (async () => {
      try {
        const [nextGroup, nextMembers, nextExpenses, nextSettlements] = await Promise.all([
          baaki.group(groupId),
          baaki.members(groupId),
          baaki.expenses(groupId),
          baaki.settlements(groupId),
        ]);
        if (!active) return;
        setGroup(nextGroup);
        setMembers(nextMembers);
        setExpenses(nextExpenses);
        setSettlements(nextSettlements);
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
      <main>
        <div className="card">
          <p className="muted">{t.group.loading}</p>
        </div>
      </main>
    );
  }

  // RLS answers "not yours" with no rows rather than an error, which is the
  // right behaviour and a confusing screen unless it is said plainly.
  if (!group) {
    return (
      <main>
        <div className="card">
          <h1>{t.group.notYours}</h1>
          <p>{error ?? t.group.notYoursBody}</p>
        </div>
      </main>
    );
  }

  const currency = group.default_currency;
  const ledger = computeLedger(expenses, settlements, currency);
  const byId = new Map(members.map((member) => [member.id, member]));
  const live = expenses.filter((expense) => !expense.deleted_at && expense.currentVersion);

  return (
    <main>
      <div className="card">
        <h1>
          {group.cover_emoji ? `${group.cover_emoji} ` : ''}
          {group.name?.trim() || t.group.yourGroup}
        </h1>
        <p className="faint">
          {plural(locale, members.length, t.group.peopleCount)} ·{' '}
          {plural(locale, live.length, t.group.expenseCount)}
        </p>
      </div>

      <div className="card">
        <h2>{t.group.whereEveryoneStands}</h2>
        {members.map((member) => {
          const net = ledger.balances.get(member.id) ?? 0n;
          return (
            <div className="row" key={member.id}>
              <span>{nameOf(member)}</span>
              <span
                className={`money ${net > 0n ? 'owed' : net < 0n ? 'owe' : ''}`}
                aria-label={`${nameOf(member)} ${
                  net === 0n ? t.group.isSettledUp : net > 0n ? t.group.isOwed : t.group.owes
                } ${money(net < 0n ? -net : net, currency)}`}
              >
                {net === 0n ? t.group.settledUp : money(net < 0n ? -net : net, currency)}
              </span>
            </div>
          );
        })}
      </div>

      {ledger.transfers.length > 0 ? (
        <div className="card">
          <h2>{t.group.whoPaysWhom}</h2>
          <p className="faint">{t.group.whoPaysWhomNote}</p>
          {ledger.transfers.map((transfer, index) => (
            <div className="row" key={index}>
              <span>
                {nameOf(byId.get(transfer.from) ?? fallback(transfer.from))} →{' '}
                {nameOf(byId.get(transfer.to) ?? fallback(transfer.to))}
              </span>
              <span className="money">{money(transfer.amount, transfer.currency)}</span>
            </div>
          ))}
        </div>
      ) : null}

      {live.length > 0 ? (
        <div className="card">
          <h2>{t.group.recent}</h2>
          {live.slice(0, 12).map((expense) => {
            const version = expense.currentVersion;
            if (!version) return null;
            return (
              <div className="row" key={expense.id}>
                <span>
                  {version.description}
                  <br />
                  <span className="faint">{version.expense_date}</span>
                </span>
                <span className="money">{money(BigInt(version.amount), version.currency)}</span>
              </div>
            );
          })}
        </div>
      ) : null}

      <Link className="button" href={`/g/${groupId}/add`}>
        {t.group.addAnExpense}
      </Link>

      <p className="faint" style={{ textAlign: 'center' }}>
        {t.group.installNote}
      </p>
    </main>
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
