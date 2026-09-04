/**
 * receipt-parse — a photograph becomes line items (ADR-008 / TDR §6).
 *
 * The model reads the receipt; it does not decide anything. What it returns is
 * checked against the receipt's own arithmetic by @waves/core before anybody
 * sees a number, and a bill that does not add up comes back flagged for
 * correction rather than quietly becoming an expense. "AI proposes, human
 * confirms" only means something if the human is told what to look at.
 *
 * The API key lives here and only here (ADR-008 / TDR §11) — it is never in the
 * app bundle, and the client cannot reach the model except through this
 * function, which checks membership and quota first.
 */

import { checkReceipt, type ParsedReceipt } from '../_shared/core.js';
import {
  asCaller,
  asService,
  serveWithCors,
  errorResponse,
  HttpError,
  json,
  requireMembership,
} from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';
import { readObjectBytes } from '../_shared/r2.ts';

/** The media type Anthropic is told, keyed off the stored object's extension. */
function mediaTypeForPath(path: string): 'image/png' | 'image/webp' | 'image/jpeg' {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  if (ext === 'png') return 'image/png';
  if (ext === 'webp') return 'image/webp';
  return 'image/jpeg';
}

interface ParseRequest {
  groupId: string;
  receiptId?: string;
  /** Object path in the private `receipts` bucket. */
  storagePath?: string;
  /** A pasted bill (Swiggy, Zomato, a WhatsApp message) instead of a photo. */
  rawText?: string;
  source?: 'camera' | 'gallery' | 'text_paste';
  currency?: string;
}

/**
 * The shape the model must return. Enforced by structured outputs, so the
 * response is parseable by construction rather than by hope — no regex, no
 * retry-on-bad-JSON loop.
 *
 * Every amount is an integer in **minor units** (ADR-003). Asking for paise
 * rather than rupees is what keeps a float from ever existing between the
 * photograph and the ledger.
 */
const RECEIPT_SCHEMA = {
  type: 'object',
  properties: {
    merchant: { type: ['string', 'null'] },
    date: { type: ['string', 'null'], description: 'ISO date, YYYY-MM-DD, or null' },
    currency: { type: 'string', description: 'ISO 4217 code, e.g. INR' },
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          qty: { type: 'number' },
          unitPrice: { type: ['integer', 'null'] },
          total: { type: 'integer' },
          confidence: { type: 'number', description: '0 to 1' },
        },
        required: ['label', 'qty', 'unitPrice', 'total', 'confidence'],
        additionalProperties: false,
      },
    },
    subtotal: { type: ['integer', 'null'] },
    taxes: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, amount: { type: 'integer' } },
        required: ['label', 'amount'],
        additionalProperties: false,
      },
    },
    serviceCharge: { type: ['integer', 'null'] },
    tip: { type: ['integer', 'null'] },
    discounts: {
      type: 'array',
      items: {
        type: 'object',
        properties: { label: { type: 'string' }, amount: { type: 'integer' } },
        required: ['label', 'amount'],
        additionalProperties: false,
      },
    },
    grandTotal: { type: 'integer' },
  },
  required: [
    'merchant',
    'date',
    'currency',
    'items',
    'subtotal',
    'taxes',
    'serviceCharge',
    'tip',
    'discounts',
    'grandTotal',
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You transcribe restaurant and shop receipts into structured data.

Read what is printed. Do not compute, correct, or tidy: if the receipt's own
arithmetic is wrong, return its numbers as printed — a separate check compares
your reading against the printed total, and that check only works if you have
not silently fixed anything.

Amounts are integers in the currency's minor unit. ₹320.50 is 32050. A receipt
printed in whole rupees still returns paise: ₹320 is 32000.

Receipts are frequently Indian and may be in Tamil, Hindi, or another regional
script, often mixed with English. Transcribe item names in the script they are
printed in. Pasted text bills from Swiggy, Zomato or WhatsApp arrive without a
photograph and read the same way.

Confidence is your own, per line, from 0 to 1. A crisp printed line is near 1.
Report low confidence when a line is faded, cut off, ambiguous, or you are
guessing at a digit — a flagged line gets a human's attention, and that is much
cheaper than a wrong number reaching somebody's ledger.

Combo meals and modifiers printed as separate indented lines under a parent
item are separate line items if they carry their own price, and part of the
parent if they do not.`;

const MODEL = 'claude-opus-5';
/**
 * ADR-011: a scan costs real money, so the quota is enforced server-side — and
 * the number now comes from `waves_receipt_scan_quota()`, which reads what the
 * person is entitled to. It used to be a 20 here and a second 20 inside that
 * function, which is two places to forget when somebody pays.
 *
 * This is only the floor to fall back to. Not zero, because a database that
 * answered oddly should not lock out somebody who has paid; not unlimited, for
 * the obvious reason.
 */
const FALLBACK_SCAN_LIMIT = 20;

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const apiKey = Deno.env.get('ANTHROPIC_API_KEY');
    if (!apiKey) {
      throw new HttpError(
        503,
        'SCANNING_UNAVAILABLE',
        'Receipt scanning is not configured on this Waves server',
      );
    }

    const body = (await request.json()) as ParseRequest;
    if (!body.storagePath && !body.rawText) {
      throw new HttpError(400, 'NOTHING_TO_PARSE', 'Send a photo or some text');
    }

    const caller = asCaller(request);
    const { profileId } = await requireMembership(caller, body.groupId);
    const service = asService();

    // Speed first, then the monthly allowance. Both refuse with a 429 and they
    // are not the same refusal: this one says slow down, the next says you have
    // spent what you are entitled to this month.
    await enforceRateLimit(service, request, 'receipt-parse', profileId);

    // Quota before the model call, never after — the point is not to spend the
    // money, not to notice afterwards that we did.
    const { data: quota } = await caller.rpc('waves_receipt_scan_quota');
    const row = quota as { used?: number; limit?: number } | null;
    const used = Number(row?.used ?? 0);
    const limit = Number.isFinite(Number(row?.limit)) ? Number(row?.limit) : FALLBACK_SCAN_LIMIT;
    if (used >= limit) {
      throw new HttpError(
        429,
        'SCAN_QUOTA_REACHED',
        `You have used all ${limit} scans this month. Adding items by hand is free and always will be.`,
      );
    }

    // The per-group receipt ceiling (ADR-011). Checked before the model call
    // for the same reason as the quota: refuse a spend that would be capped at
    // record time anyway. Paid groups are exempt inside the RPC; a `false` here
    // means an unpaid group that has filled its free receipts. `record_receipt`
    // enforces the same rule as the real boundary, so this is only to save the
    // model call and give a clean 429 instead of a raised `RECEIPT_CAP`.
    //
    // Pass the receipt id so a re-parse of an *existing* receipt (an update) is
    // not refused at cap: the recorder lets an update through, and the gate must
    // agree or a legitimate re-scan is blocked with a spend that never happens.
    const { data: canAdd } = await caller.rpc('waves_can_add_receipt', {
      p_group_id: body.groupId,
      p_receipt_id: body.receiptId ?? null,
    });
    if (canAdd === false) {
      throw new HttpError(
        429,
        'RECEIPT_CAP_REACHED',
        'This group has reached its receipt limit. Upgrade or add storage to add more.',
      );
    }

    const content: unknown[] = [];
    if (body.storagePath) {
      // IDOR guard: the download runs with the service role, which bypasses
      // bucket RLS. `groupId` was checked by requireMembership above; the client
      // uploads to `${groupId}/${receiptId}.ext`, so require that prefix or a
      // caller could read another group's receipt by passing its object path.
      if (!body.storagePath.startsWith(`${body.groupId}/`)) {
        throw new HttpError(403, 'FORBIDDEN', 'That image does not belong to this group');
      }
      // Read with the service role from whichever backend holds it (R2 for new
      // uploads, Supabase Storage for anything from before the cut-over) and
      // sent as base64: the model never gets a URL into our storage.
      let bytes: Uint8Array;
      try {
        bytes = await readObjectBytes(service, 'receipts', body.storagePath);
      } catch (readError) {
        const message = readError instanceof Error ? readError.message : 'No such image';
        throw new HttpError(400, 'IMAGE_UNREADABLE', message);
      }
      content.push({
        type: 'image',
        source: {
          type: 'base64',
          media_type: mediaTypeForPath(body.storagePath),
          data: encodeBase64(bytes),
        },
      });
    }
    content.push({
      type: 'text',
      text: body.rawText
        ? `Transcribe this bill. Currency is ${body.currency ?? 'INR'}.\n\n${body.rawText}`
        : `Transcribe this receipt. Currency is ${body.currency ?? 'INR'} unless the receipt says otherwise.`,
    });

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        // Transcription, not deliberation: low effort keeps a scan cheap, which
        // is what lets the free tier be generous (ADR-011).
        output_config: {
          effort: 'low',
          format: { type: 'json_schema', schema: RECEIPT_SCHEMA },
        },
        messages: [{ role: 'user', content }],
      }),
    });

    if (!response.ok) {
      const detail = await response.text();
      console.error('anthropic error', response.status, detail.slice(0, 500));

      // Say *why*, not just that it failed. "The scanner could not read that
      // just now" told the person nothing and told whoever had to debug it
      // less — the only copy of the reason was in a log nobody watching a
      // phone can reach. The upstream type and message are the model's
      // complaint about the request, never about the key, so they are safe to
      // pass on.
      let reason = '';
      try {
        const upstream = JSON.parse(detail) as { error?: { type?: string; message?: string } };
        reason = [upstream.error?.type, upstream.error?.message].filter(Boolean).join(': ');
      } catch {
        reason = detail.slice(0, 200);
      }
      throw new HttpError(
        502,
        'SCAN_FAILED',
        `The scanner could not read that just now (${response.status}${reason ? ` ${reason}` : ''})`,
      );
    }

    const message = (await response.json()) as {
      content: { type: string; text?: string }[];
      stop_reason?: string;
      usage?: { input_tokens?: number; output_tokens?: number };
    };

    // A refusal is a successful HTTP 200 with an empty content array, so
    // reading content[0] unconditionally would throw on the one case we most
    // want to report clearly.
    if (message.stop_reason === 'refusal') {
      throw new HttpError(422, 'SCAN_REFUSED', 'The scanner declined to read that image');
    }

    const text = message.content?.find((block) => block.type === 'text')?.text;
    if (!text) throw new HttpError(502, 'SCAN_FAILED', 'The scanner returned nothing');

    const parsed = JSON.parse(text) as ParsedReceipt;

    // The receipt's own checksum. This is what stands between a misread digit
    // and somebody's ledger.
    const check = checkReceipt(parsed);
    const status = check.reconciles && check.problems.length === 0 ? 'parsed' : 'needs_review';

    const { data: receiptId, error: recordError } = await service.rpc('waves_record_receipt', {
      p_group_id: body.groupId,
      p_receipt_id: body.receiptId ?? null,
      p_profile_id: profileId,
      p_source: body.source ?? (body.rawText ? 'text_paste' : 'camera'),
      p_storage_path: body.storagePath ?? null,
      p_raw_text: body.rawText ?? null,
      p_parsed: parsed,
      p_status: status,
      p_input_tokens: message.usage?.input_tokens ?? 0,
      p_output_tokens: message.usage?.output_tokens ?? 0,
    });
    if (recordError) throw new HttpError(500, 'INTERNAL', recordError.message);

    return json({
      receiptId,
      status,
      parsed,
      check,
      quota: { used: used + 1, limit },
    });
  } catch (error) {
    return errorResponse(error, { fn: 'receipt-parse' });
  }
});

/** Deno has no Buffer; chunked so a large image cannot blow the call stack. */
function encodeBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}
