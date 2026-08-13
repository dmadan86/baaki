'use client';

/**
 * Settling up, in the browser (ADR-007).
 *
 * The debts shown are @baaki/core's, simplified to the fewest payments that
 * square everybody (the same `who pays whom` the group page draws). Recording a
 * payment is not performing it: the ledger tracks what people say they paid,
 * made real only when whoever was paid confirms. Every write is a SECURITY
 * DEFINER RPC — nothing here writes a balance, and the server recomputes what it
 * is handed rather than trusting it (TDR §4).
 *
 * The pay link, when a rail publishes one, is built by @baaki/core so the phone
 * and the browser hand off to UPI the same way. A rail with no published link is
 * the ordinary case, not a failure — you record that you paid in cash instead.
 */

import { Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import {
  computeLedger,
  memberName,
  type Expense,
  type GroupRow,
  type MemberRow,
  type Settlement,
} from '@baaki/api-client';
import {
  buildPaymentUri,
  defaultRailFor,
  railById,
  railsFor,
  toMajorString,
  type CurrencyCode,
} from '@baaki/core';

import { AppFrame } from '@/components/AppFrame';
import { SkeletonRows } from '@/components/Skeleton';
import { baaki } from '@/lib/baaki';
import { money } from '@/lib/money';
import { useStrings } from '@/i18n-context';

export default function SettlePage() {
  return (
    <AppFrame current="settle">
      {({ profileId }) => (
        <Suspense fallback={null}>
          <Settle profileId={profileId} />
        </Suspense>
      )}
    </AppFrame>
  );
}

function Settle({ profileId }: { profileId: string }) {
  const { t } = useStrings();
  const search = useSearchParams();
  const wantedGroup = search.get('group');

  const [groups, setGroups] = useState<GroupRow[]>([]);
  const [membersByGroup, setMembersByGroup] = useState<Map<string, MemberRow[]>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [g, m] = await Promise.all([baaki.myGroups(), baaki.membersByGroup()]);
        if (!active) return;
        setGroups(g);
        setMembersByGroup(m);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  // The clicked group if still present, else the one asked for in the URL, else
  // the first — derived, never a setState-in-effect that fights the URL.
  const effectiveId =
    (selectedId && groups.some((group) => group.id === selectedId) && selectedId) ||
    (wantedGroup && groups.some((group) => group.id === wantedGroup) && wantedGroup) ||
    groups[0]?.id ||
    null;

  if (loading) {
    return (
      <div className="app-body">
        <div className="app-main">
          <section className="panel">
            <SkeletonRows rows={5} />
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
          <h1>{t.settle.title}</h1>
        </div>

        {groups.length > 1 ? (
          <div className="people" style={{ marginBottom: 14 }}>
            {groups.map((group) => (
              <button
                key={group.id}
                type="button"
                className="chip"
                aria-pressed={group.id === effectiveId}
                onClick={() => setSelectedId(group.id)}
              >
                {group.cover_emoji ? `${group.cover_emoji} ` : ''}
                {group.name?.trim() || t.settle.pickGroup}
              </button>
            ))}
          </div>
        ) : null}

        {effectiveId ? (
          <GroupSettle
            key={effectiveId}
            group={groups.find((group) => group.id === effectiveId)!}
            members={membersByGroup.get(effectiveId) ?? []}
            profileId={profileId}
          />
        ) : (
          <section className="panel">
            <p className="muted">{t.dash.noGroups}</p>
          </section>
        )}
      </div>
      <aside className="detail" />
    </div>
  );
}

function GroupSettle({
  group,
  members,
  profileId,
}: {
  group: GroupRow;
  members: MemberRow[];
  profileId: string;
}) {
  const { t, locale } = useStrings();
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [settlements, setSettlements] = useState<Settlement[]>([]);
  const [loading, setLoading] = useState(true);
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [nudged, setNudged] = useState<Set<string>>(new Set());
  const [openSettle, setOpenSettle] = useState<string | null>(null);

  useEffect(() => {
    // The component is keyed by group id, so a group switch remounts with
    // loading already true; a `reload` bump refetches in place without blanking
    // what is on screen (the row's own button carries the busy state).
    let active = true;
    void (async () => {
      try {
        const [e, s] = await Promise.all([baaki.expenses(group.id), baaki.settlements(group.id)]);
        if (!active) return;
        setExpenses(e);
        setSettlements(s);
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [group.id, reload]);

  const byId = useMemo(() => new Map(members.map((member) => [member.id, member])), [members]);
  const myMemberId = members.find((member) => member.profile_id === profileId)?.id ?? null;

  const ledger = useMemo(
    () => computeLedger(expenses, settlements, group.default_currency),
    [expenses, settlements, group.default_currency],
  );

  if (loading) {
    return (
      <section className="panel">
        <SkeletonRows rows={3} />
      </section>
    );
  }

  const iOwe = ledger.transfers.filter((transfer) => transfer.from === myMemberId);
  const owesMe = ledger.transfers.filter((transfer) => transfer.to === myMemberId);
  const pending = settlements.filter((settlement) => settlement.status === 'initiated');

  if (iOwe.length === 0 && owesMe.length === 0 && pending.length === 0) {
    return (
      <section className="panel">
        <p className="muted">{t.settle.allSettled}</p>
      </section>
    );
  }

  async function refresh() {
    setReload((n) => n + 1);
  }

  async function confirm(settlementId: string) {
    setBusy(settlementId);
    try {
      await baaki.confirmSettlement(settlementId);
      await refresh();
    } finally {
      setBusy(null);
    }
  }

  async function nudge(toMemberId: string, currency: string) {
    setBusy(toMemberId);
    try {
      await baaki.nudgeToSettle({ groupId: group.id, toMemberId, currency });
      setNudged((prev) => new Set(prev).add(toMemberId));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      {iOwe.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>{t.settle.youOweHead}</h2>
          </div>
          <div className="list">
            {iOwe.map((transfer) => {
              const payee = byId.get(transfer.to);
              const open = openSettle === transfer.to;
              return (
                <div key={transfer.to}>
                  <div className="item" style={{ cursor: 'default' }}>
                    <span className="grow">
                      <span className="title">{payee ? memberName(payee) : t.settle.title}</span>
                    </span>
                    <span className="amount neg">
                      {money(transfer.amount, transfer.currency, locale)}
                    </span>
                    <button
                      type="button"
                      className="btn"
                      style={{ marginInlineStart: 10 }}
                      onClick={() => setOpenSettle(open ? null : transfer.to)}
                    >
                      {t.settle.settleUp}
                    </button>
                  </div>
                  {open && myMemberId && payee ? (
                    <SettleForm
                      group={group}
                      payee={payee}
                      fromMemberId={myMemberId}
                      amount={transfer.amount}
                      currency={transfer.currency}
                      onCancel={() => setOpenSettle(null)}
                      onRecorded={async () => {
                        setOpenSettle(null);
                        await refresh();
                      }}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {owesMe.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>{t.settle.owesYouHead}</h2>
          </div>
          <div className="list">
            {owesMe.map((transfer) => {
              const payer = byId.get(transfer.from);
              const isNudged = nudged.has(transfer.from);
              return (
                <div key={transfer.from} className="item" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title">{payer ? memberName(payer) : t.settle.title}</span>
                  </span>
                  <span className="amount pos">
                    {money(transfer.amount, transfer.currency, locale)}
                  </span>
                  <button
                    type="button"
                    className="btn soft"
                    style={{ marginInlineStart: 10 }}
                    disabled={isNudged || busy === transfer.from}
                    onClick={() => void nudge(transfer.from, transfer.currency)}
                  >
                    {isNudged ? t.settle.nudged : t.settle.nudge}
                  </button>
                </div>
              );
            })}
          </div>
        </section>
      ) : null}

      {pending.length > 0 ? (
        <section className="panel">
          <div className="panel-head">
            <h2>{t.settle.pendingHead}</h2>
          </div>
          <div className="list">
            {pending.map((settlement) => {
              const mineToConfirm = settlement.to_member_id === myMemberId;
              const other = byId.get(
                mineToConfirm ? settlement.from_member_id : settlement.to_member_id,
              );
              return (
                <div key={settlement.id} className="item" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title">{other ? memberName(other) : t.settle.title}</span>
                  </span>
                  <span className="amount">
                    {money(BigInt(settlement.amount), settlement.currency, locale)}
                  </span>
                  {mineToConfirm ? (
                    <button
                      type="button"
                      className="btn"
                      style={{ marginInlineStart: 10 }}
                      disabled={busy === settlement.id}
                      onClick={() => void confirm(settlement.id)}
                    >
                      {busy === settlement.id ? t.settle.confirming : t.settle.confirm}
                    </button>
                  ) : (
                    <span className="faint" style={{ marginInlineStart: 10 }}>
                      {other
                        ? t.settle.waitingConfirm.replace('{name}', memberName(other))
                        : t.settle.pendingHead}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </section>
      ) : null}
    </>
  );
}

/** Pick a rail, hand off to it when it has a link, and record the payment. */
function SettleForm({
  group,
  payee,
  fromMemberId,
  amount,
  currency,
  onCancel,
  onRecorded,
}: {
  group: GroupRow;
  payee: MemberRow;
  fromMemberId: string;
  amount: bigint;
  currency: string;
  onCancel: () => void;
  onRecorded: () => Promise<void>;
}) {
  const { t, locale } = useStrings();
  const rails = useMemo(() => railsFor(group.country_code), [group.country_code]);
  const [rail, setRail] = useState<string>(() => defaultRailFor(group.country_code));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handle = payee.vpa ?? payee.profile?.default_vpa ?? '';
  const railInfo = railById(rail);
  const needsHandle = railInfo ? railInfo.handle !== 'none' : false;

  const payLink =
    handle && needsHandle
      ? buildPaymentUri(
          {
            railId: rail,
            handle,
            payeeName: memberName(payee),
            amount,
            currency: currency as CurrencyCode,
            note: `Baaki ${group.name ?? ''}`.trim(),
          },
          (value, code) => toMajorString({ minor: value, currency: code }),
        )
      : null;

  async function record() {
    setSaving(true);
    setError(null);
    try {
      await baaki.recordSettlement({
        groupId: group.id,
        fromMemberId,
        toMemberId: payee.id,
        amount,
        rail,
        currency,
      });
      await onRecorded();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }

  return (
    <div className="settle-form">
      <label style={{ display: 'block', marginBottom: 10 }}>
        <span className="k" style={{ display: 'block', marginBottom: 6 }}>
          {t.settle.howPaid}
        </span>
        <select
          className="split-input"
          value={rail}
          onChange={(event) => setRail(event.target.value)}
          style={{ width: '100%' }}
        >
          {rails.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </label>

      <div className="detail-field">
        <span className="k">{t.settle.amountLabel}</span>
        <span className="v amount">{money(amount, currency, locale)}</span>
      </div>

      {needsHandle && !handle ? (
        <p className="faint">{t.settle.noHandle.replace('{name}', memberName(payee))}</p>
      ) : null}

      {payLink ? (
        <a
          className="btn soft block"
          href={payLink.uri}
          target="_blank"
          rel="noreferrer"
          style={{ marginTop: 10 }}
        >
          {t.settle.payWith.replace('{rail}', railInfo?.label ?? rail)}
        </a>
      ) : null}

      {error ? <p className="dispute-note">{error}</p> : null}

      <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
        <button type="button" className="btn" onClick={() => void record()} disabled={saving}>
          {saving ? t.settle.recording : t.settle.record}
        </button>
        <button type="button" className="btn soft" onClick={onCancel} disabled={saving}>
          {t.settle.cancel}
        </button>
      </div>
    </div>
  );
}
