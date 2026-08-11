'use client';

/**
 * One expense, in full.
 *
 * Who paid and who owes what are read straight off the current version — the
 * server already computed and wrote them, so this screen never re-derives a
 * share (TDR §4). Delete, restore and every dispute action go through an RPC in
 * @baaki/api-client; the tables are read-only to clients (ADR-004). A dispute
 * moves no number — it is a claim everyone sees until somebody edits.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';

import {
  nameOf,
  type DisputeRow,
  type Expense,
  type ExpenseVersionSummary,
  type Member,
} from '@baaki/api-client';

import { AppFrame } from '@/components/AppFrame';
import { baaki } from '@/lib/baaki';
import { money } from '@/lib/money';
import { fill } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function ExpensePage() {
  return (
    <AppFrame current="groups">
      {({ profileId }) => <ExpenseDetail profileId={profileId} />}
    </AppFrame>
  );
}

function ExpenseDetail({ profileId }: { profileId: string }) {
  const { t, locale } = useStrings();
  const params = useParams<{ groupId: string; expenseId: string }>();
  const router = useRouter();
  const { groupId, expenseId } = params;

  const [expense, setExpense] = useState<Expense | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [versions, setVersions] = useState<ExpenseVersionSummary[]>([]);
  const [disputes, setDisputes] = useState<DisputeRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [reason, setReason] = useState('');

  const load = useCallback(async () => {
    const [e, m, v, d] = await Promise.all([
      baaki.expense(expenseId),
      baaki.members(groupId),
      baaki.expenseVersions(expenseId),
      baaki.disputes(groupId),
    ]);
    setExpense(e);
    setMembers(m);
    setVersions(v);
    setDisputes(d.filter((row) => row.expense_id === expenseId));
  }, [expenseId, groupId]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        await load();
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [load]);

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      setError(null);
      try {
        await action();
        await load();
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        setBusy(false);
        setConfirmDelete(false);
      }
    },
    [load],
  );

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

  const version = expense?.currentVersion ?? null;
  if (!expense || !version) {
    return (
      <div className="app-body">
        <div className="app-main">
          <div className="panel">
            <h2>{t.expense.notFound}</h2>
            <Link className="btn soft" href={`/g/${groupId}`} style={{ marginTop: 12 }}>
              {t.dash.openGroup}
            </Link>
          </div>
        </div>
        <aside className="detail" />
      </div>
    );
  }

  const byId = new Map(members.map((m) => [m.id, m]));
  const nameFor = (id: string) => nameOf(byId.get(id) ?? fallback(id));
  const currency = version.currency;
  const deleted = Boolean(expense.deleted_at);

  const myMember = members.find((m) => m.profile_id === profileId) ?? null;
  const isAdmin = myMember?.role === 'admin';
  const openDispute = disputes.find((d) => d.status === 'open') ?? null;
  const myOpenDispute = openDispute && myMember && openDispute.member_id === myMember.id;

  const splitKind = version.split_type as keyof typeof t.expense.splitKind;
  const splitLabel = t.expense.splitKind[splitKind] ?? version.split_type;

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <div>
            <h1>
              {version.description}
              {deleted ? <span className="pill-badge">{t.expense.deletedBadge}</span> : null}
              {openDispute ? (
                <span className="pill-badge warn">{t.expense.disputedBadge}</span>
              ) : null}
            </h1>
            <div className="sub">
              {version.expense_date} · {splitLabel}
            </div>
          </div>
          <div className="amount" style={{ fontSize: 22 }}>
            {money(BigInt(version.amount), currency, locale)}
          </div>
        </div>

        <section className="panel">
          <div className="panel-head">
            <h2>{t.expense.paidBy}</h2>
          </div>
          <div className="list">
            {version.payers.map((payer) => (
              <div key={payer.member_id} className="item" style={{ cursor: 'default' }}>
                <span className="grow">
                  <span className="title">{nameFor(payer.member_id)}</span>
                </span>
                <span className="amount">{money(BigInt(payer.amount), currency, locale)}</span>
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{t.expense.splitLabel}</h2>
          </div>
          <div className="list">
            {version.shares.map((share) => (
              <div key={share.member_id} className="item" style={{ cursor: 'default' }}>
                <span className="grow">
                  <span className="title" style={{ fontWeight: 500 }}>
                    {nameFor(share.member_id)}
                  </span>
                </span>
                <span className="amount neg">{money(BigInt(share.amount), currency, locale)}</span>
              </div>
            ))}
          </div>
        </section>

        {versions.length > 1 ? (
          <section className="panel">
            <div className="panel-head">
              <h2>{t.expense.history}</h2>
            </div>
            <div className="list">
              {versions.map((v) => (
                <div key={v.id} className="item" style={{ cursor: 'default' }}>
                  <span className="grow">
                    <span className="title" style={{ fontWeight: 500 }}>
                      {fill(t.expense.versionNo, { n: v.version_no })} · {v.description}
                    </span>
                    <span className="meta">{new Date(v.created_at).toLocaleString(locale)}</span>
                  </span>
                  <span className="amount">{money(BigInt(v.amount), v.currency, locale)}</span>
                </div>
              ))}
            </div>
          </section>
        ) : null}

        {error ? <p className="error">{error}</p> : null}
      </div>

      <aside className="detail">
        {!deleted ? (
          <Link
            className="btn block"
            href={`/g/${groupId}/add?expense=${expenseId}`}
            style={{ marginBottom: 10 }}
          >
            {t.expense.edit}
          </Link>
        ) : null}

        {deleted ? (
          <button
            type="button"
            className="btn soft block"
            disabled={busy}
            onClick={() => void run(() => baaki.restoreExpense(expenseId))}
          >
            {t.expense.restore}
          </button>
        ) : (
          <button
            type="button"
            className="btn soft block"
            disabled={busy}
            onClick={() => {
              if (confirmDelete)
                void run(() =>
                  baaki.deleteExpense(expenseId).then(() => router.replace(`/g/${groupId}`)),
                );
              else setConfirmDelete(true);
            }}
          >
            {confirmDelete ? t.expense.confirmDelete : t.expense.delete}
          </button>
        )}

        {!deleted ? (
          <div style={{ marginTop: 18 }}>
            <div className="panel-head">
              <h2>{t.expense.disputes}</h2>
            </div>

            {myOpenDispute ? (
              <button
                type="button"
                className="btn soft block"
                disabled={busy}
                onClick={() => void run(() => baaki.withdrawDispute(expenseId))}
              >
                {t.expense.withdraw}
              </button>
            ) : !openDispute ? (
              <>
                <input
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder={t.expense.reasonPlaceholder}
                  aria-label={t.expense.reasonPlaceholder}
                  style={{ marginBottom: 10 }}
                />
                <button
                  type="button"
                  className="btn soft block"
                  disabled={busy}
                  onClick={() => void run(() => baaki.disputeExpense({ expenseId, reason }))}
                >
                  {t.expense.raiseDispute}
                </button>
              </>
            ) : null}

            {openDispute ? (
              <div className="dispute-note">
                <div className="who">{nameFor(openDispute.member_id)}</div>
                {openDispute.reason ? <div className="why">“{openDispute.reason}”</div> : null}
                {isAdmin ? (
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <button
                      type="button"
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          baaki.resolveDispute({ disputeId: openDispute.id, accept: true }),
                        )
                      }
                    >
                      {t.expense.markNeedsFix}
                    </button>
                    <button
                      type="button"
                      className="btn soft"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          baaki.resolveDispute({ disputeId: openDispute.id, accept: false }),
                        )
                      }
                    >
                      {t.expense.markCorrect}
                    </button>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </aside>
    </div>
  );
}

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
