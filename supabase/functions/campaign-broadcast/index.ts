/**
 * campaign-broadcast — sends a campaign to its targeted cohort by email
 * (TDR §7, §7.3 — the broadcast half of A21).
 *
 * The in-app half shows the announcement inside the app. This is the other door:
 * the same words in the inbox, for the people who have not opened the app since
 * the campaign started. It is deliberately dumb, exactly like `notify-fanout` —
 * claim, render, send, record — and every decision that matters lives in SQL:
 *
 *   * who is mailed, and the one rule that cannot be got wrong — the holdout is
 *     never among them — is `baaki_claim_campaign_emails`;
 *   * the dedup that stops a second press mailing the same person twice is the
 *     UNIQUE on `campaign_email_sends`, claimed as an INSERT;
 *   * a bounce or complaint is suppressed by the existing `email-events` webhook,
 *     because a campaign send writes the same `email_events` row a notification
 *     does.
 *
 * Nobody signed in can call this. It reads other people's addresses and cohorts,
 * which is the service role's business and no one else's — so, like the fanout,
 * the gate is a plain comparison against the service key rather than a JWT.
 *
 * Bounded on purpose. One invocation sends at most `MAX_PER_RUN`, spaced to
 * Resend's two-a-second limit, and reports whether more remain. The console
 * presses again for the next slice rather than this function running for the
 * minutes a whole audience would take and timing out halfway.
 */

import {
  asService,
  serveWithCors,
  errorResponse,
  HttpError,
  json,
  type SupabaseClient,
} from '../_shared/auth.ts';
import {
  buildCampaignFor,
  pause,
  emailKeyName,
  emailSendable,
  sendCampaignEmail,
  SEND_SPACING_MS,
  type CampaignEmailRow,
  type CampaignSendResult,
} from '../_shared/email.ts';

/** One claim's worth. Small, because the claim is an INSERT that holds a lock. */
const EMAIL_BATCH = 25;

/**
 * The most one invocation will send. At the 600ms spacing Resend needs, 150 is
 * about ninety seconds of sending — comfortably inside an edge function's wall
 * clock, with room for the claim and finish round trips around it.
 */
const MAX_PER_RUN = 150;

const UUID = /^[0-9a-f-]{36}$/i;

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST a campaign id to broadcast it');
    }

    const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!expected || request.headers.get('Authorization') !== `Bearer ${expected}`) {
      throw new HttpError(401, 'NOT_AUTHORISED', 'This endpoint is not for clients');
    }

    // Email off is a deployment that has not turned it on, and the console should
    // be told rather than left pressing a button that silently does nothing.
    const sendable = emailSendable();
    if (!sendable.ok) {
      throw new HttpError(
        503,
        'EMAIL_NOT_CONFIGURED',
        sendable.reason ||
          `Email is not configured on this deployment — set ${emailKeyName()} and EMAIL_UNSUBSCRIBE_SECRET.`,
      );
    }

    const body = (await request.json().catch(() => ({}))) as { campaign_id?: unknown };
    const campaignId = typeof body.campaign_id === 'string' ? body.campaign_id.trim() : '';
    if (!UUID.test(campaignId)) {
      throw new HttpError(400, 'BAD_CAMPAIGN_ID', 'campaign_id must be a uuid');
    }

    const service = asService();
    const outcome = await broadcast(service, campaignId);
    return json(outcome);
  } catch (error) {
    return errorResponse(error, { fn: 'campaign-broadcast' });
  }
});

interface Broadcast {
  readonly campaign_id: string;
  readonly sent: number;
  readonly failed: number;
  readonly retry: number;
  /** True when the last claim came back full, so there is likely more to send. */
  readonly more: boolean;
}

async function broadcast(service: SupabaseClient, campaignId: string): Promise<Broadcast> {
  let sent = 0;
  let failed = 0;
  let retry = 0;
  let processed = 0;
  // Assume more until a claim comes back short, which is the only proof the
  // queue is drained. A run that hits the cap on full batches leaves this true.
  let more = true;

  while (processed < MAX_PER_RUN) {
    const want = Math.min(EMAIL_BATCH, MAX_PER_RUN - processed);
    const { data, error } = await service.rpc('baaki_claim_campaign_emails', {
      p_campaign_id: campaignId,
      p_limit: want,
    });
    if (error) throw new HttpError(500, 'CLAIM_FAILED', error.message);

    const rows = (data ?? []) as CampaignEmailRow[];
    if (rows.length === 0) {
      more = false;
      break;
    }

    const results: CampaignSendResult[] = [];
    for (const row of rows) {
      if (processed > 0 || results.length > 0) await pause(SEND_SPACING_MS);
      results.push(await sendCampaignEmail(await buildCampaignFor(row)));
    }

    const { error: finishError } = await service.rpc('baaki_finish_campaign_emails', {
      p_results: results,
    });
    // A finish that fails leaves the rows 'queued'. The claim will not re-pick
    // them (they exist), so they are stranded rather than double-sent — the safe
    // direction — and this is loud rather than a silent hole.
    if (finishError) throw new HttpError(500, 'FINISH_FAILED', finishError.message);

    sent += results.filter((result) => result.status === 'sent').length;
    failed += results.filter((result) => result.status === 'failed').length;
    retry += results.filter((result) => result.status === 'retry').length;
    processed += rows.length;

    // Fewer than asked for means the queue is drained. Stop, and say so.
    if (rows.length < want) {
      more = false;
      break;
    }
  }

  return { campaign_id: campaignId, sent, failed, retry, more };
}
