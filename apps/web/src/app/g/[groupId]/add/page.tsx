'use client';

/**
 * Adding an expense with nothing installed — the point of the whole link.
 *
 * Equal splits only. That is not laziness: a guest is adding the auto they
 * just paid for, and every extra control between them and Save is a chance
 * they give up and the expense never gets recorded at all. Exact shares,
 * itemised bills and percentages are in the app, and this screen says so.
 *
 * The amount is typed in major units and converted with @baaki/core, so no
 * float ever exists between the keyboard and the ledger (ADR-003). The server
 * recomputes every share from the parameters regardless of what is sent — the
 * numbers below are a claim to be checked, not an instruction (TDR §4).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

import { computeShares, parseMajor, serialiseSplitParams, type CurrencyCode } from '@baaki/core';
import { nameOf, type Group, type Member } from '@baaki/api-client';

import { baaki } from '@/lib/baaki';
import { money } from '@/lib/money';
import { fill } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function AddExpensePage() {
  const params = useParams<{ groupId: string }>();
  const router = useRouter();
  const groupId = params.groupId;
  const { t } = useStrings();

  const [group, setGroup] = useState<Group | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [myProfileId, setMyProfileId] = useState<string | null>(null);

  const [description, setDescription] = useState('');
  const [amountText, setAmountText] = useState('');
  const [payer, setPayer] = useState<string | null>(null);
  const [participants, setParticipants] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void (async () => {
      const [nextGroup, nextMembers, profileId] = await Promise.all([
        baaki.group(groupId),
        baaki.members(groupId),
        baaki.currentProfileId(),
      ]);
      if (!active) return;
      setGroup(nextGroup);
      setMembers(nextMembers);
      setMyProfileId(profileId);
      setParticipants(nextMembers.map((member) => member.id));
      // Whoever is holding the phone is usually the one who just paid.
      setPayer(nextMembers.find((member) => member.profile_id === profileId)?.id ?? null);
    })();
    return () => {
      active = false;
    };
  }, [groupId]);

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

  /**
   * Shown before saving, because "split equally" hides the fact that ₹100
   * between three people is 33.34 / 33.33 / 33.33 and somebody is a paisa
   * worse off. Better seen than discovered.
   */
  const preview = useMemo(() => {
    if (!amount || amount <= 0n || participants.length === 0) return null;
    try {
      return computeShares({
        amount,
        currency,
        params: { kind: 'equal' },
        participants,
        // The server seeds the remainder rotation on the expense id it ends up
        // writing, so this preview can differ by one minor unit from the final
        // answer. It is a preview of the shape, not a promise of the cents.
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
        // A guest on a phone browser is exactly who taps Save twice on a slow
        // connection. This is what makes the second tap harmless (ADR-005).
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
    participants,
    groupId,
    description,
    currency,
    router,
    t.add.defaultDescription,
  ]);

  if (!group) {
    return (
      <main>
        <div className="card">
          <p className="muted">{t.group.loading}</p>
        </div>
      </main>
    );
  }

  const ready = Boolean(amount && amount > 0n && payer && participants.length > 0);

  return (
    <main>
      <div className="card">
        <h1>{t.add.title}</h1>
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
        />
        {amountText.trim() && amount === null ? <p className="error">{t.add.notAnAmount}</p> : null}
      </div>

      <div className="card">
        <h2>{t.add.whoPaid}</h2>
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
      </div>

      <div className="card">
        <h2>{t.add.splitBetween}</h2>
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
        {preview ? (
          <>
            {[...preview].map(([memberId, share]) => (
              <div className="row" key={memberId}>
                <span>{nameOf(members.find((m) => m.id === memberId) ?? members[0]!)}</span>
                <span className="money">{money(share, currency)}</span>
              </div>
            ))}
            <p className="faint">{t.add.splitEquallyNote}</p>
          </>
        ) : null}
      </div>

      {error ? <p className="error">{error}</p> : null}

      <button type="button" onClick={() => void save()} disabled={!ready || saving}>
        {saving ? t.add.saving : t.add.save}
      </button>
      <button type="button" className="ghost" onClick={() => router.back()}>
        {t.add.cancel}
      </button>
    </main>
  );
}
