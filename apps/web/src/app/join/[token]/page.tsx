'use client';

/**
 * The link somebody was sent.
 *
 * This is the whole growth loop in one screen (ADR-006): a person taps a link
 * in WhatsApp and is in the group, on a phone with nothing installed. No
 * account to make, no app store, no password.
 *
 * The one thing this screen must get right is the claim. Somebody was probably
 * already added as a ghost — "Ravi", typed in by whoever started the group —
 * and the expenses filed against that name are the point of them arriving at
 * all. Taking that place keeps the history; skipping it makes a second Ravi
 * and the group now has two people who are one person, which nothing
 * downstream can undo. So the claim is offered first and by name.
 */

import { useCallback, useEffect, useState } from 'react';
import { useParams, useRouter } from 'next/navigation';

import type { InvitePreview } from '@waves/api-client';

import { waves } from '@/lib/waves';
import { fill, plural } from '@/i18n';
import { useStrings } from '@/i18n-context';

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;
  const { t, locale } = useStrings();

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A claim has been sent and is waiting on an admin of the group. */
  const [pending, setPending] = useState(false);

  useEffect(() => {
    let active = true;
    void waves
      .previewInvite(token)
      .then((result) => {
        if (active) setPreview(result);
      })
      .catch((caught: unknown) => {
        if (active) setError(caught instanceof Error ? caught.message : String(caught));
      });
    return () => {
      active = false;
    };
  }, [token]);

  /**
   * `claim` is a parameter rather than read from state, because "join as
   * someone new instead" clears the claim and joins in one tap — and the state
   * update is not visible to the call that follows it.
   */
  const join = useCallback(
    async (claim: string | null = claimId) => {
      setError(null);
      setJoining(true);
      try {
        // The guest account is made first, then the invite is accepted against
        // it. Same account when they later add an email, so the group and its
        // history stay theirs rather than being re-joined as a stranger.
        await waves.signInAsGuest();
        const accepted = await waves.acceptInvite({
          token,
          claimMemberId: claim,
          displayName: name.trim() || null,
        });

        // Claiming somebody's place only asks now (ADR-006). Routing into the
        // group would land on a page this person cannot read: they are not a
        // member until an admin of the group agrees.
        if (accepted.pending) {
          setPending(true);
          setJoining(false);
          return;
        }
        router.replace(`/g/${accepted.group.id}`);
      } catch (caught) {
        setError(caught instanceof Error ? caught.message : String(caught));
        setJoining(false);
      }
    },
    [token, claimId, name, router],
  );

  if (error && !preview) {
    return (
      <main>
        <div className="card">
          <h1>{t.join.linkBroken}</h1>
          <p>{error}</p>
          <p className="faint">{t.join.linkBrokenBody}</p>
        </div>
      </main>
    );
  }

  if (!preview) {
    return (
      <main>
        <div className="card">
          <p className="muted">{t.join.opening}</p>
        </div>
      </main>
    );
  }

  const groupName = preview.group?.name?.trim() || t.join.aGroup;
  const claimedName =
    preview.claimable.find((person) => person.memberId === claimId)?.name ?? t.join.someone;

  if (pending) {
    return (
      <main>
        <div className="card">
          <h1>{t.join.waitingTitle}</h1>
          <p>{fill(t.join.waitingBody, { group: groupName, name: claimedName })}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            setClaimId(null);
            setPending(false);
            void join(null);
          }}
          disabled={joining}
        >
          {t.join.joinAsNewInstead}
        </button>
      </main>
    );
  }

  return (
    <main>
      <div className="card">
        <h1>
          {preview.group?.cover_emoji ? `${preview.group.cover_emoji} ` : ''}
          {fill(t.join.addedTo, { group: groupName })}
        </h1>
        <p>{plural(locale, preview.memberCount, t.join.splittingHere)}</p>
      </div>

      {preview.claimable.length > 0 ? (
        <div className="card">
          <h2>{t.join.whichOneAreYou}</h2>
          <p className="faint">{t.join.claimNote}</p>
          <div className="people">
            {preview.claimable.map((person) => (
              <button
                key={person.memberId}
                type="button"
                className="chip"
                aria-pressed={claimId === person.memberId}
                onClick={() => setClaimId(person.memberId)}
              >
                {person.name ?? t.join.someone}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              aria-pressed={claimId === null}
              onClick={() => setClaimId(null)}
            >
              {t.join.noneOfThese}
            </button>
          </div>
        </div>
      ) : null}

      {claimId === null ? (
        <div className="card">
          <h2>{t.join.yourName}</h2>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t.join.namePlaceholder}
            aria-label={t.join.yourName}
            autoComplete="name"
          />
          <p className="faint">{t.join.onlyThingAsked}</p>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <button type="button" onClick={() => void join()} disabled={joining}>
        {joining
          ? t.join.joining
          : claimId
            ? fill(t.join.askToJoinAs, { name: claimedName })
            : fill(t.join.joinGroup, { group: groupName })}
      </button>
    </main>
  );
}
