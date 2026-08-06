/**
 * notify-fanout — taps people on the shoulder about what is already in their
 * inbox (TDR §7.1).
 *
 * The inbox is written the moment something happens, by whichever job or RPC
 * caused it. This function is only the delivery half, and it is deliberately
 * dumb: claim, render, send, record. Everything that could be got wrong lives
 * somewhere it can be tested without a phone —
 *
 *   * claiming and closing out: `baaki_claim_push_notifications`, which is an
 *     UPDATE rather than a SELECT so two overlapping runs cannot both send the
 *     same reminder;
 *   * building the messages and reading the tickets: `@baaki/core`, including
 *     the mapping from a flat reply back to which device said what.
 *
 * Nobody signed in can call this. It reads other people's inboxes, which is the
 * service role's business and no one else's.
 */

import { buildPushBatch, chunk, readPushTickets, type ExpoTicket } from '../_shared/core.js';
import { asService, CORS_HEADERS, errorResponse, HttpError, json } from '../_shared/auth.ts';

const EXPO_ENDPOINT = 'https://exp.host/--/api/v2/push/send';

interface ClaimedRow {
  id: string;
  kind: string;
  title: string;
  body: string;
  deep_link: string | null;
  payload: Record<string, unknown>;
  locale: string;
  tokens: string[];
}

/** The facts a push can interpolate, taken from the row that was written. */
function factsOf(payload: Record<string, unknown>): Record<string, string | undefined> {
  const text = (key: string): string | undefined =>
    typeof payload[key] === 'string' ? (payload[key] as string) : undefined;
  return {
    amount: text('amount'),
    currency: text('currency'),
    counterparty: text('counterparty'),
    group: text('group'),
    description: text('description'),
    count: text('count'),
  };
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    // A plain comparison against the service key rather than a JWT check: this
    // is machine-to-machine, the caller is a scheduler, and the key never
    // leaves the server on either side.
    const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!expected || request.headers.get('Authorization') !== `Bearer ${expected}`) {
      throw new HttpError(401, 'NOT_AUTHORISED', 'This endpoint is not for clients');
    }

    const service = asService();

    const { data, error } = await service.rpc('baaki_claim_push_notifications', { p_limit: 200 });
    if (error) throw new HttpError(500, 'CLAIM_FAILED', error.message);

    const rows = (data ?? []) as ClaimedRow[];
    if (rows.length === 0) return json({ claimed: 0, sent: 0 });

    const batch = buildPushBatch(
      rows.map((row) => ({
        id: row.id,
        kind: row.kind,
        title: row.title,
        body: row.body,
        deepLink: row.deep_link,
        facts: factsOf(row.payload ?? {}),
        locale: row.locale,
        tokens: row.tokens,
      })),
    );

    const delivered: string[] = [];
    const failed: string[] = [];
    const revoke: string[] = [];

    const messageChunks = chunk(batch.messages);
    const targetChunks = chunk(batch.targets);

    for (const [index, messages] of messageChunks.entries()) {
      const targets = targetChunks[index] ?? [];
      let tickets: ExpoTicket[] = [];

      try {
        const response = await fetch(EXPO_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(messages),
        });
        const parsed = (await response.json()) as { data?: ExpoTicket[] };
        tickets = parsed.data ?? [];
      } catch (unreachable) {
        // Expo being down is not a reason to lose the notification. An empty
        // ticket list marks the whole chunk failed, and the row stays in the
        // inbox where the person will still see it.
        console.error('expo push unreachable:', (unreachable as Error).message);
      }

      const outcome = readPushTickets(targets, tickets);
      delivered.push(...outcome.delivered);
      failed.push(...outcome.failed);
      revoke.push(...outcome.revoke);
    }

    const { error: finishError } = await service.rpc('baaki_finish_push', {
      p_delivered: delivered,
      p_failed: failed,
      p_revoke: revoke,
    });
    if (finishError) throw new HttpError(500, 'FINISH_FAILED', finishError.message);

    return json({
      claimed: rows.length,
      sent: delivered.length,
      failed: failed.length,
      revoked: revoke.length,
    });
  } catch (error) {
    return errorResponse(error, { fn: 'notify-fanout' });
  }
});
