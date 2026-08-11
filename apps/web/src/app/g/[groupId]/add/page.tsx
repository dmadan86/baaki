'use client';

/**
 * Adding an expense in the web client.
 *
 * Equal splits, as on the guest view: a guest adding the auto they just paid
 * for gives up at every extra control, and exact shares / itemised bills are
 * richer flows still to come (see PLAN.md, Phase 2 remainder). The amount is
 * typed in major units and converted with @baaki/core, so no float ever exists
 * between the keyboard and the ledger (ADR-003); the server recomputes every
 * share regardless of what is sent (TDR §4). Reskinned into the app frame, with
 * the split previewed live on the right.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { computeShares, parseMajor, serialiseSplitParams, type CurrencyCode } from '@baaki/core';
import { nameOf, type Group, type Member } from '@baaki/api-client';

import { AppFrame } from '@/components/AppFrame';
import { baaki } from '@/lib/baaki';
import { money } from '@/lib/money';
import { fill } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function AddExpensePage() {
  return (
    <AppFrame current="groups">{({ profileId }) => <AddExpense myProfileId={profileId} />}</AppFrame>
  );
}

function AddExpense({ myProfileId }: { myProfileId: string }) {
  const params = useParams<{ groupId: string }>();
  const router = useRouter();
  const groupId = params.groupId;
  const { t, locale } = useStrings();

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [payer, setPayer] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [nextGroup, nextMembers] = await Promise.all([
        baaki.group(groupId),
        baaki.members(groupId),
      ]);
      if (!active) return;
      setGroup(nextGroup);
      setMembers(nextMembers);
      setParticipants(nextMembers.map((member) => member.id));
      // Whoever is signed in is usually the one who just paid.
      setPayer(nextMembers.find((member) => member.profile_id === myProfileId)?.id ?? null);
    })();
    return () => {
      active = false;
    };
  }, [groupId, myProfileId]);

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

  // Shown before saving, because "split equally" hides that ₹100 between three
  // is 33.34 / 33.33 / 33.33 and somebody is a paisa worse off.
  const preview = useMemo(() => {
    if (!amount || amount <= 0n || participants.length === 0) return null;
    try {
      return computeShares({
        amount,
        currency,
        params: { kind: 'equal' },
        participants,
        seed: 'preview',
      });
    } catch {
      return null;
    }
  }, [amount, currency, participants]);

  const toggle = useCallback((memberId: string) => {
    setParticipants((current) =>
      current.includes(memberId)
        ? current.filter((item) => item !== memberId)
        : [...current, memberId],
    );
  }, []);

  const save = useCallback(async () => {
    if (!amount || amount <= 0n || !payer || participants.length === 0) return;
    setError(null);
    setSaving(true);
    try {
      await baaki.writeExpense({
        groupId,
        description: description.trim() || t.add.defaultDescription,
        expenseDate: new Date().toISOString().slice(0, 10),
        currency,
        amount,
        splitParams: serialiseSplitParams({ kind: 'equal' }),
        participants,
        payers: { [payer]: amount },
        clientMutationId: crypto.randomUUID(),
      });
      router.replace(`/g/${groupId}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setSaving(false);
    }
  }, [amount, payer, participants, groupId, description, currency, router, t.add.defaultDescription]);

  if (!group) {
    return (
      <div className="app-body">
        <div className="app-main">
          <p className="muted">{t.group.loading}</p>
        </div>
        <aside className="detail" />
      </div>
    );
  }

  const ready = Boolean(amount && amount > 0n && payer && participants.length > 0);

  return (
    <div className="app-body">
      <div className="app-main">
        <div className="page-head">
          <div>
            <h1>{t.add.title}</h1>
            <div className="sub">
              {group.cover_emoji ? `${group.cover_emoji} ` : ''}
              {group.name?.trim() || t.group.yourGroup}
            </div>
          </div>
        </div>

        <section className="panel">
          <input
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder={t.add.whatWasIt}
            aria-label={t.add.whatWasIt}
          />
          <input
            value={amountText}
            onChange={(event) => setAmountText(event.target.value)}
            inputMode="decimal"
            placeholder={fill(t.add.howMuch, { currency })}
            aria-label={fill(t.add.amountIn, { currency })}
            style={{ marginTop: 6 }}
          />
          {amountText.trim() && amount === null ? (
            <p className="error">{t.add.notAnAmount}</p>
          ) : null}
        </section>

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
            <h2>{t.add.splitBetween}</h2>
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
          <p className="faint" style={{ marginTop: 10 }}>
            {t.add.splitEquallyNote}
          </p>
        </section>

        {error ? <p className="error">{error}</p> : null}

        <div style={{ display: 'flex', gap: 10 }}>
          <button type="button" className="btn" onClick={() => void save()} disabled={!ready || saving}>
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
            {[...preview].map(([memberId, share]) => (
              <div key={memberId} className="detail-field">
                <span className="v" style={{ fontWeight: 500 }}>
                  {nameOf(members.find((m) => m.id === memberId) ?? members[0]!)}
                </span>
                <span className="amount">{money(share, currency, locale)}</span>
              </div>
            ))}
          </div>
        ) : (
          <p className="detail-empty">{t.add.splitEquallyNote}</p>
        )}
      </aside>
    </div>
  );
}
