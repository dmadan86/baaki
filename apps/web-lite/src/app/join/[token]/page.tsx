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

import type { InvitePreview } from '@baaki/api-client';

import { baaki } from '@/lib/baaki';

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const router = useRouter();
  const token = params.token;

  const [preview, setPreview] = useState<InvitePreview | null>(null);
  const [claimId, setClaimId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [joining, setJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void baaki
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

  const join = useCallback(async () => {
    setError(null);
    setJoining(true);
    try {
      // The guest account is made first, then the invite is accepted against
      // it. Same account when they later add an email, so the group and its
      // history stay theirs rather than being re-joined as a stranger.
      await baaki.signInAsGuest();
      const accepted = await baaki.acceptInvite({
        token,
        claimMemberId: claimId,
        displayName: claimId ? null : name.trim() || null,
      });
      router.replace(`/g/${accepted.group.id}`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setJoining(false);
    }
  }, [token, claimId, name, router]);

  if (error && !preview) {
    return (
      <main>
        <div className="card">
          <h1>This link does not work</h1>
          <p>{error}</p>
          <p className="faint">
            Links expire, and whoever shared it can turn it off. Ask them for a new one.
          </p>
        </div>
      </main>
    );
  }

  if (!preview) {
    return (
      <main>
        <div className="card">
          <p className="muted">Opening the link…</p>
        </div>
      </main>
    );
  }

  const groupName = preview.group?.name?.trim() || 'a group';

  return (
    <main>
      <div className="card">
        <h1>
          {preview.group?.cover_emoji ? `${preview.group.cover_emoji} ` : ''}
          You have been added to {groupName}
        </h1>
        <p>
          {preview.memberCount} {preview.memberCount === 1 ? 'person is' : 'people are'} splitting
          costs here. You can join and add an expense right now — nothing to install.
        </p>
      </div>

      {preview.claimable.length > 0 ? (
        <div className="card">
          <h2>Which one are you?</h2>
          <p className="faint">
            Somebody already added these names. Picking yours keeps the expenses already filed
            against it.
          </p>
          <div className="people">
            {preview.claimable.map((person) => (
              <button
                key={person.memberId}
                type="button"
                className="chip"
                aria-pressed={claimId === person.memberId}
                onClick={() => setClaimId(person.memberId)}
              >
                {person.name ?? 'Someone'}
              </button>
            ))}
            <button
              type="button"
              className="chip"
              aria-pressed={claimId === null}
              onClick={() => setClaimId(null)}
            >
              None of these
            </button>
          </div>
        </div>
      ) : null}

      {claimId === null ? (
        <div className="card">
          <h2>Your name</h2>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="What should they call you?"
            aria-label="Your name"
            autoComplete="name"
          />
          <p className="faint">
            This is the only thing asked of you. No email, no password, no app.
          </p>
        </div>
      ) : null}

      {error ? <p className="error">{error}</p> : null}

      <button type="button" onClick={() => void join()} disabled={joining}>
        {joining ? 'Joining…' : `Join ${groupName}`}
      </button>
    </main>
  );
}
