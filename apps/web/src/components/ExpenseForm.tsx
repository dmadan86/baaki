'use client';

/**
 * Adding or editing an expense, with the split methods the web can express:
 * equal, exact amounts, percentages, and shares. Itemised and per-member
 * adjustment splits are the app's (and the receipt flow's) — editing one of
 * those here would flatten it, so the form says so and stays out of the way.
 *
 * Numbers never become floats on their way to the ledger: amounts are parsed
 * to minor units with @waves/core (ADR-003), and every share is previewed by
 * the same `computeShares` the server runs, so what is shown is what will be
 * written (TDR §4). The server still recomputes and owns the answer.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { useRouter } from 'next/navigation';

import {
  computeShares,
  money as coreMoney,
  parseMajor,
  parseSplitParams,
  serialiseSplitParams,
  toMajorString,
  type CurrencyCode,
  type ExpenseLocation,
  type SplitParams,
} from '@waves/core';
import { nameOf, type Group, type Member } from '@waves/api-client';

import { baaki } from '@/lib/baaki';
import { money as fmtMoney } from '@/lib/money';
import { captureLocation, coordLabel, geolocationSupported, LocationFailure } from '@/lib/geo';
import { fill } from '@/i18n';
import { useStrings } from '@/i18n-context';

enum SplitKind {
  Equal = 'equal',
  Exact = 'exact',
  Percent = 'percent',
  Shares = 'shares',
}
const KINDS: SplitKind[] = [SplitKind.Equal, SplitKind.Exact, SplitKind.Percent, SplitKind.Shares];

export function ExpenseForm({
  groupId,
  myProfileId,
  expenseId,
}: {
  groupId: string;
  myProfileId: string;
  expenseId: string | null;
}) {
  const router = useRouter();
  const { t, locale } = useStrings();
  const editing = Boolean(expenseId);

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [ready, setReady] = useState(false);
  const [unsupported, setUnsupported] = useState(false);

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [expenseDate, setExpenseDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [payer, setPayer] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [kind, setKind] = useState<SplitKind>(SplitKind.Equal);
  // Per-member raw text, kept as typed; parsed only when building the params.
  const [exact, setExact] = useState<Record<string, string>>({});
  const [percent, setPercent] = useState<Record<string, string>>({});
  const [weights, setWeights] = useState<Record<string, string>>({});

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Where the spend happened (A43). Optional and opt-in: null until the person
  // clicks "Add location" and the browser grants it. Coordinates only on the web
  // (no on-device reverse-geocode — see lib/geo).
  const [location, setLocation] = useState<ExpenseLocation | null>(null);
  const [locBusy, setLocBusy] = useState(false);
  const [locFailure, setLocFailure] = useState<LocationFailure | null>(null);
  // `navigator` does not exist during SSR, so reading it at render would make the
  // server (no panel) and the first client render (panel) disagree — a hydration
  // mismatch. useSyncExternalStore gives React a distinct server snapshot
  // (false) and client snapshot, so hydration matches and the panel appears
  // afterward on a browser that can locate. Support does not change at runtime,
  // so the subscription is a no-op.
  const canGeo = useSyncExternalStore(
    () => () => {},
    () => geolocationSupported,
    () => false,
  );

  const addLocation = useCallback(async () => {
    setLocFailure(null);
    setLocBusy(true);
    try {
      const result = await captureLocation();
      if (result.ok) setLocation(result.location);
      else if (result.why !== LocationFailure.Unsupported) setLocFailure(result.why);
    } finally {
      setLocBusy(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [g, m, existing] = await Promise.all([
          baaki.group(groupId),
          baaki.members(groupId),
          expenseId ? baaki.expense(expenseId) : Promise.resolve(null),
        ]);
        if (!active) return;
        setGroup(g);
        setMembers(m);

        const version = existing?.currentVersion ?? null;
        if (version) {
          const currency = version.currency as CurrencyCode;
          // Several payers is the app's own split; rewriting it here would
          // collapse everyone's contribution onto the first payer. Bail out to
          // the read-only note instead of silently changing the ledger.
          if (version.payers.length > 1) {
            setUnsupported(true);
            return;
          }
          setDescription(version.description);
          setAmountText(toMajorString(coreMoney(BigInt(version.amount), currency)));
          setExpenseDate(version.expense_date);
          setPayer(version.payers[0]?.member_id ?? null);
          setParticipants(version.shares.map((s) => s.member_id));
          setLocation(version.location ?? null);
          try {
            // Deserialise the stored split back into the editor. Anything the web
            // cannot express (adjustment, itemised) drops to a read-only note.
            const parsed = parseSplitParams(version.split_params);
            switch (parsed.kind) {
              case 'equal':
                setKind(SplitKind.Equal);
                break;
              case 'exact':
                setKind(SplitKind.Exact);
                setExact(
                  Object.fromEntries(
                    Object.entries(parsed.amounts).map(([id, minor]) => [
                      id,
                      toMajorString(coreMoney(minor, currency)),
                    ]),
                  ),
                );
                break;
              case 'percent':
                setKind(SplitKind.Percent);
                setPercent(
                  Object.fromEntries(
                    Object.entries(parsed.basisPoints).map(([id, bp]) => [id, String(bp / 100)]),
                  ),
                );
                break;
              case 'shares':
                setKind(SplitKind.Shares);
                setWeights(
                  Object.fromEntries(
                    Object.entries(parsed.weights).map(([id, w]) => [id, String(w)]),
                  ),
                );
                break;
              default:
                setUnsupported(true);
            }
          } catch {
            setUnsupported(true);
          }
        } else {
          setParticipants(m.map((member) => member.id));
          setPayer(m.find((member) => member.profile_id === myProfileId)?.id ?? null);
        }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (active) setReady(true);
      }
    })();
    return () => {
      active = false;
    };
  }, [groupId, expenseId, myProfileId]);

  const currency = (group?.default_currency ?? 'INR') as CurrencyCode;

  const amount = useMemo(() => {
    const trimmed = amountText.trim();
    if (!trimmed) return null;
    try {
      return parseMajor(trimmed, currency).minor;
    } catch {
      return null;
    }
  }, [amountText, currency]);

  const params = useMemo<SplitParams | null>(() => {
    if (participants.length === 0) return null;
    try {
      switch (kind) {
        case SplitKind.Equal:
          return { kind: 'equal' };
        case SplitKind.Exact: {
          const amounts: Record<string, bigint> = {};
          for (const id of participants) {
            amounts[id] = parseMajor(exact[id]?.trim() || '0', currency).minor;
          }
          return { kind: 'exact', amounts };
        }
        case SplitKind.Percent: {
          const basisPoints: Record<string, number> = {};
          for (const id of participants) {
            const raw = percent[id]?.trim() || '0';
            if (!/^\d+(\.\d+)?$/.test(raw)) return null;
            const value = Number.parseFloat(raw);
            basisPoints[id] = Math.round(value * 100);
          }
          return { kind: 'percent', basisPoints };
        }
        case SplitKind.Shares: {
          const w: Record<string, number> = {};
          for (const id of participants) {
            const raw = weights[id]?.trim() || '0';
            if (!/^\d+$/.test(raw)) return null;
            const value = Number.parseInt(raw, 10);
            w[id] = value;
          }
          return { kind: 'shares', weights: w };
        }
      }
    } catch {
      return null;
    }
    return null;
  }, [kind, participants, exact, percent, weights, currency]);

  // The same computation the server runs — a preview only where it is valid.
  const preview = useMemo(() => {
    if (!amount || amount <= 0n || !params) return null;
    try {
      return computeShares({
        amount,
        currency,
        params,
        participants,
        seed: expenseId ?? 'preview',
      });
    } catch {
      return null;
    }
  }, [amount, currency, params, participants, expenseId]);

  const toggle = useCallback((memberId: string) => {
    setParticipants((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  }, []);

  const save = useCallback(async () => {
    if (!amount || amount <= 0n || !payer || !params || !preview) return;
    setError(null);
    setSaving(true);
    try {
      await baaki.writeExpense({
        groupId,
        expenseId: expenseId ?? undefined,
        description: description.trim() || t.add.defaultDescription,
        expenseDate,
        currency,
        amount,
        splitParams: serialiseSplitParams(params),
        participants,
        payers: { [payer]: amount },
        expectedShares: Object.fromEntries(preview),
        location,
        clientMutationId: crypto.randomUUID(),
      });
      router.replace(`/g/${groupId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }, [
    amount,
    payer,
    params,
    preview,
    groupId,
    expenseId,
    description,
    expenseDate,
    currency,
    participants,
    location,
    router,
    t.add.defaultDescription,
  ]);

  if (!ready || !group) {
    return (
      <div className="app-body">
        <div className="app-main">
          {error ? <p className="error">{error}</p> : <p className="muted">{t.group.loading}</p>}
        </div>
        <aside className="detail" />
      </div>
    );
  }

  if (unsupported) {
    return (
      <div className="app-body">
        <div className="app-main">
          <div className="panel">
            <h2>{t.add.editTitle}</h2>
            <p className="muted">{t.add.cannotEditSplit}</p>
            <button type="button" className="btn soft" onClick={() => router.back()}>
              {t.add.cancel}
            </button>
          </div>
        </div>
        <aside className="detail" />
      </div>
    );
  }

  const canSave = Boolean(amount && amount > 0n && payer && participants.length > 0 && preview);
  const invalid = Boolean(amount && amount > 0n && participants.length > 0 && !preview);

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <div>
            <h1>{editing ? t.add.editTitle : t.add.title}</h1>
            <div className="sub">
              {group.cover_emoji ? `${group.cover_emoji} ` : ''}
              {group.name?.trim() || t.group.yourGroup}
            </div>
          </div>
        </div>

        <section className="panel">
          <input
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t.add.whatWasIt}
            aria-label={t.add.whatWasIt}
          />
          <input
            value={amountText}
            onChange={(e) => setAmountText(e.target.value)}
            inputMode="decimal"
            placeholder={fill(t.add.howMuch, { currency })}
            aria-label={fill(t.add.amountIn, { currency })}
            style={{ marginTop: 6 }}
          />
          {amountText.trim() && amount === null ? (
            <p className="error">{t.add.notAnAmount}</p>
          ) : null}
        </section>

        {/* Where it happened (A43) — optional, opt-in, coordinates only on the
            web (no on-device reverse-geocode). Absent when the browser has no
            geolocation at all. */}
        {canGeo ? (
          <section className="panel">
            <div className="panel-head">
              <h2>{t.location.label}</h2>
            </div>
            {location ? (
              <div className="row" style={{ alignItems: 'center', gap: 8 }}>
                <span aria-hidden>📍</span>
                <span style={{ flex: 1 }}>{location.name?.trim() || coordLabel(location)}</span>
                <button
                  type="button"
                  className="btn soft"
                  onClick={() => setLocation(null)}
                  aria-label={t.location.remove}
                >
                  {t.location.remove}
                </button>
              </div>
            ) : (
              <button
                type="button"
                className="btn soft"
                onClick={() => void addLocation()}
                disabled={locBusy}
              >
                {locBusy ? t.location.adding : t.location.add}
              </button>
            )}
            {locFailure === LocationFailure.Denied ? (
              <p className="muted" style={{ marginTop: 6 }}>
                {t.location.blocked}
              </p>
            ) : locFailure === LocationFailure.Unavailable ? (
              <p className="muted" style={{ marginTop: 6 }}>
                {t.location.unavailable}
              </p>
            ) : null}
          </section>
        ) : null}

        <section className="panel">
          <div className="panel-head">
            <h2>{t.add.whoPaid}</h2>
          </div>
          <div className="people">
            {members.map((member) => (
              <button
                key={member.id}
                type="button"
                className="chip"
                aria-pressed={payer === member.id}
                onClick={() => setPayer(member.id)}
              >
                {member.profile_id === myProfileId ? t.add.you : nameOf(member)}
              </button>
            ))}
          </div>
        </section>

        <section className="panel">
          <div className="panel-head">
            <h2>{t.add.splitMethod}</h2>
          </div>
          <div className="people" style={{ marginBottom: 12 }}>
            {KINDS.map((k) => (
              <button
                key={k}
                type="button"
                className="chip"
                aria-pressed={kind === k}
                onClick={() => setKind(k)}
              >
                {t.expense.splitKind[k]}
              </button>
            ))}
          </div>

          <div className="people">
            {members.map((member) => (
              <button
                key={member.id}
                type="button"
                className="chip"
                aria-pressed={participants.includes(member.id)}
                onClick={() => toggle(member.id)}
              >
                {member.profile_id === myProfileId ? t.add.you : nameOf(member)}
              </button>
            ))}
          </div>

          {kind !== SplitKind.Equal ? (
            <div className="list" style={{ marginTop: 12 }}>
              {participants.map((id) => {
                const member = members.find((m) => m.id === id);
                const value =
                  kind === SplitKind.Exact
                    ? (exact[id] ?? '')
                    : kind === SplitKind.Percent
                      ? (percent[id] ?? '')
                      : (weights[id] ?? '');
                const setter =
                  kind === SplitKind.Exact
                    ? setExact
                    : kind === SplitKind.Percent
                      ? setPercent
                      : setWeights;
                return (
                  <div key={id} className="split-input">
                    <span className="grow">{member ? nameOf(member) : id}</span>
                    <input
                      value={value}
                      inputMode={kind === SplitKind.Shares ? 'numeric' : 'decimal'}
                      onChange={(e) => setter((cur) => ({ ...cur, [id]: e.target.value }))}
                      aria-label={member ? nameOf(member) : id}
                    />
                    <span className="unit">
                      {kind === SplitKind.Exact ? currency : kind === SplitKind.Percent ? '%' : '×'}
                    </span>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="faint" style={{ marginTop: 10 }}>
              {t.add.splitEquallyNote}
            </p>
          )}

          {invalid ? (
            <p className="error" style={{ marginTop: 8 }}>
              {t.add.invalidSplit}
            </p>
          ) : null}
        </section>

        {error ? <p className="error">{error}</p> : null}

        <div style={{ display: 'flex', gap: 10 }}>
          <button
            type="button"
            className="btn"
            onClick={() => void save()}
            disabled={!canSave || saving}
          >
            {saving ? t.add.saving : t.add.save}
          </button>
          <button type="button" className="btn soft" onClick={() => router.back()}>
            {t.add.cancel}
          </button>
        </div>
      </div>

      <aside className="detail">
        <div className="panel-head">
          <h2>{t.add.splitBetween}</h2>
        </div>
        {preview ? (
          <div className="list">
            {[...preview].map(([memberId, share]) => {
              const member = members.find((m) => m.id === memberId);
              return (
                <div key={memberId} className="detail-field">
                  <span className="v" style={{ fontWeight: 500 }}>
                    {member ? nameOf(member) : memberId}
                  </span>
                  <span className="amount">{fmtMoney(share, currency, locale)}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="detail-empty">{invalid ? t.add.invalidSplit : t.add.splitEquallyNote}</p>
        )}
      </aside>
    </div>
  );
}
