/**
 * The model tier of speak-an-expense — used only when the reader has brought a
 * key (see aiKeys), and never otherwise.
 *
 * The heuristic parser in voiceExpense.ts is certain and free, but it reads with
 * rules written for English-shaped sentences: a number, a currency word, a group
 * name it can see. It cannot follow "பணம் ஐநூறு ரூபாய் மளிகைக்கு" the way a model
 * can, and it hedges on anything it is not sure of. When a key is present the
 * caller layers this on top — a model reads the whole transcript, in whatever
 * language it was spoken, and hands back the same {@link VoiceParseResult} shape
 * the heuristic does, so the screen downstream does not care which tier produced
 * it.
 *
 * This is best-effort by construction: it is one network round-trip to somebody
 * else's paid account, over a link that may be slow or down, returning free-form
 * text that may or may not be the JSON we asked for. Every one of those failure
 * modes — no key, no signal, a non-200, a truncated body, prose instead of JSON —
 * comes back as `null`, which the caller reads as "the model could not help this
 * time" and falls through to the heuristic. It never throws into the add-expense
 * flow, and it never blocks it for longer than a few seconds.
 *
 * The credential goes straight from this device to the provider the reader chose,
 * exactly as aiKeys promises — Baaki has no copy and this file adds no path to
 * one. The transcript, likewise, is sent only to that provider; the raw error on
 * a failure is reported to Sentry (scrubbed), but the key and the transcript are
 * not.
 */

import { getActiveAiKey, aiProvider, defaultAiModel, type AiProviderId } from '@/lib/aiKeys';
import { addAiTokensUsed, getAiSettings } from '@/lib/aiSettings';
import { reportHandled } from '@/lib/observability';
import type {
  VoiceExpenseItem,
  VoiceGroupRef,
  VoiceGroupTarget,
  VoiceParseResult,
} from '@/lib/voiceExpense';

/**
 * What the model needs beyond the words: which groups exist so it can match one
 * by name, the reader's locale so it leans into the right language, and the
 * currency to assume when a line names none.
 */
export interface VoiceLlmContext {
  /** The reader's groups; only those with a non-null name are offered to the model. */
  groups: readonly VoiceGroupRef[];
  /** The app's active locale — 'en' | 'ta' | 'hi' | 'ar' — a nudge, not a fence. */
  locale: string;
  /** The ISO currency to fill in when the speaker names none. */
  defaultCurrency: string;
}

/** How long we will wait on the provider before giving up and falling back. */
export const REQUEST_TIMEOUT_MS = 8000;

/** A ceiling on the answer — a handful of expenses is plenty; runaway output is a bug. */
const MAX_TOKENS = 500;

/**
 * Prompt-size ceilings. The transcript, the group list, and each group name are
 * all model- or speaker-influenced free text; without a bound, a reader with
 * hundreds of groups, a pathologically long name, or a runaway transcript would
 * inflate the request (and its token cost) without limit. These clamp each input
 * before it is sent — the request stays a predictable size no matter what comes
 * in. Truncation is for the wire only: the real group names are untouched, so
 * name-matching in {@link mapGroup} still runs against the full stored name.
 */
/** At most this many of the reader's groups are listed in the prompt. */
export const MAX_GROUPS_IN_PROMPT = 100;
/** A group name is truncated to this many chars in the prompt, and a created name is capped to it. */
export const MAX_GROUP_NAME_CHARS = 80;
/** The transcript is truncated to this many chars before it is sent. */
export const MAX_TRANSCRIPT_CHARS = 1000;

/**
 * The JSON the model is asked to return, before we trust any of it. Every field
 * is optional and `unknown`, because it comes from a language model and the whole
 * point of the mapping below is to not believe it until it is checked.
 */
interface RawLlmItem {
  amount?: unknown;
  currency?: unknown;
  note?: unknown;
}

interface RawLlmGroup {
  type?: unknown;
  name?: unknown;
}

interface RawLlmResult {
  items?: unknown;
  group?: unknown;
}

/**
 * The instruction the model works to. Kept blunt and schema-first: the one thing
 * that matters is that the reply is machine-readable JSON in the exact shape the
 * mapping expects, so the prompt spends its words on that and on the couple of
 * conventions (major units, null-for-default currency) the mapping relies on.
 */
function systemPrompt(ctx: VoiceLlmContext): string {
  return [
    'You are an expense parser for a bill-splitting app.',
    'You are given a short spoken sentence, which may be in any language',
    `(the speaker's app locale is "${ctx.locale}", but honour whatever language you actually hear:`,
    'English, Tamil, Hindi, Arabic, or another).',
    'Extract every expense the sentence describes and return STRICT JSON only — no prose,',
    'no markdown, no code fences — matching exactly this schema:',
    '{"items":[{"amount":<number in MAJOR units>,"currency":<ISO 4217 string or null>,"note":<short description string>}],',
    '"group":{"type":"existing","name":<one of the provided group names>}|{"type":"create","name":<string>}|null}',
    'Amounts are positive numbers in MAJOR units: "5 rupees" is amount 5 with currency "INR", not 500.',
    `If a line names no currency, set its currency to null — the app fills the default (${ctx.defaultCurrency}).`,
    'A note is a short human description of what the money was for, with the amount and currency words removed.',
    'If the sentence asks to create a new group (e.g. "make a group called Goa"), set group to',
    '{"type":"create","name":"Goa"}. If it names one of the existing groups listed below, set group to',
    '{"type":"existing","name":"<that exact name>"}. Otherwise set group to null.',
    'Never invent a group that is neither newly requested nor in the list.',
  ].join(' ');
}

/** The user turn: the transcript, plus the existing group names to match against. */
function userPrompt(transcript: string, ctx: VoiceLlmContext): string {
  const names = ctx.groups
    .map((group) => group.name)
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
    // Offer at most a bounded number of groups. VoiceGroupRef carries no recency
    // or usage signal to rank by, so input order is preserved and simply capped.
    .slice(0, MAX_GROUPS_IN_PROMPT)
    // Truncate each name for the PROMPT only — the stored name is untouched, so a
    // match in mapGroup still runs against the true, full name.
    .map((name) =>
      name.length > MAX_GROUP_NAME_CHARS ? name.slice(0, MAX_GROUP_NAME_CHARS) : name,
    );
  const groupList = names.length > 0 ? names.map((name) => `- ${name}`).join('\n') : '(none)';
  return `Existing groups:\n${groupList}\n\nSentence:\n${transcript}`;
}

/** Where each provider's chat/messages endpoint lives. */
const CHAT_URLS: Record<AiProviderId, string> = {
  openai: 'https://api.openai.com/v1/chat/completions',
  moonshot: 'https://api.moonshot.ai/v1/chat/completions',
  anthropic: 'https://api.anthropic.com/v1/messages',
};

/**
 * The model to run: the reader's chosen override when they set one, else the
 * provider's default. A stale override that names a model this provider does not
 * list is tolerated here — the provider will reject it and we fall back — but the
 * common case is a live choice or no choice at all.
 */
async function resolveModel(id: AiProviderId): Promise<string> {
  const settings = await getAiSettings();
  // An empty stored override is no override — fall back to the provider default
  // rather than sending "" as the model and forcing the request to fail.
  const override = settings.model?.trim();
  return override ? override : defaultAiModel(id);
}

/**
 * The response body, its raw text, and the token counts if the provider reported
 * them. Split out so the OpenAI-shaped and Anthropic-shaped calls can share the
 * same parse-and-map tail.
 */
interface ProviderReply {
  /** The model's answer as text — the JSON we asked for, before parsing. */
  text: string;
  /** Total tokens the call spent, best-effort, for usage recording. Zero if unknown. */
  totalTokens: number;
}

/**
 * Ask an OpenAI-compatible provider (OpenAI, Moonshot). Both speak the same
 * chat/completions dialect, so the request and the shape of the reply are one and
 * the same; only the base URL and the model differ.
 */
async function callOpenAiCompatible(
  url: string,
  headers: Record<string, string>,
  model: string,
  ctx: VoiceLlmContext,
  transcript: string,
  signal: AbortSignal,
): Promise<ProviderReply | null> {
  const response = await fetch(url, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    signal,
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: MAX_TOKENS,
      // Force a JSON object back rather than hoping the prose is well-formed.
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: systemPrompt(ctx) },
        { role: 'user', content: userPrompt(transcript, ctx) },
      ],
    }),
  });
  if (!response.ok) return null;

  const json = (await response.json()) as {
    choices?: { message?: { content?: unknown } }[];
    usage?: { total_tokens?: unknown };
  };
  const content = json.choices?.[0]?.message?.content;
  if (typeof content !== 'string') return null;

  const total = json.usage?.total_tokens;
  return { text: content, totalTokens: typeof total === 'number' ? total : 0 };
}

/**
 * The single tool Anthropic is forced to call, so it answers with a structured
 * object rather than free text. This is Anthropic's equivalent of OpenAI's
 * `response_format: json_object`: the input_schema mirrors the shape the mapping
 * downstream expects, and `tool_choice` below makes the model fill it in. The
 * schema is a nudge, not a fence — the mapping still validates every field — but
 * it removes the prose/fence risk that a plain text answer carries.
 */
const VOICE_RESULT_TOOL = {
  name: 'record_expenses',
  description: "Record the expenses extracted from the sentence, in the app's schema.",
  input_schema: {
    type: 'object',
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            amount: { type: 'number', description: 'Positive amount in MAJOR units.' },
            currency: {
              type: ['string', 'null'],
              description: 'ISO 4217 code, or null to use the app default.',
            },
            note: { type: 'string', description: 'Short description of the expense.' },
          },
          required: ['amount'],
        },
      },
      group: {
        type: ['object', 'null'],
        properties: {
          type: { type: 'string', enum: ['existing', 'create'] },
          name: { type: 'string' },
        },
      },
    },
    required: ['items'],
  },
} as const;

/**
 * Ask Anthropic, whose Messages API takes a top-level `system` and returns a
 * content-block array rather than a single string. The dangerous-direct-browser
 * header is required because this runs inside a React Native / webview runtime
 * that Anthropic treats as a browser origin.
 *
 * We force {@link VOICE_RESULT_TOOL} so the answer arrives as a structured
 * `tool_use` block — parity with the OpenAI JSON-mode path. We stringify that
 * block back into `text` so the shared parse-and-map tail (which runs
 * parseJsonLoosely) is identical for both providers. A drifting provider that
 * returns a plain text block instead is still rescued via that fallback.
 */
async function callAnthropic(
  headers: Record<string, string>,
  model: string,
  ctx: VoiceLlmContext,
  transcript: string,
  signal: AbortSignal,
): Promise<ProviderReply | null> {
  const response = await fetch(CHAT_URLS.anthropic, {
    method: 'POST',
    headers: {
      ...headers,
      'content-type': 'application/json',
      'anthropic-dangerous-direct-browser-access': 'true',
    },
    signal,
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      temperature: 0,
      system: systemPrompt(ctx),
      messages: [{ role: 'user', content: userPrompt(transcript, ctx) }],
      tools: [VOICE_RESULT_TOOL],
      // Make the model answer through the tool rather than as prose.
      tool_choice: { type: 'tool', name: VOICE_RESULT_TOOL.name },
    }),
  });
  if (!response.ok) return null;

  const json = (await response.json()) as {
    content?: { type?: string; text?: unknown; name?: unknown; input?: unknown }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };

  const inputTokens = json.usage?.input_tokens;
  const outputTokens = json.usage?.output_tokens;
  const totalTokens =
    (typeof inputTokens === 'number' ? inputTokens : 0) +
    (typeof outputTokens === 'number' ? outputTokens : 0);

  // Preferred: the forced tool call carries the answer as a structured object.
  // Stringify it so the shared JSON tail handles both providers the same way.
  const toolBlock = json.content?.find(
    (part) => part?.type === 'tool_use' && part?.name === VOICE_RESULT_TOOL.name,
  );
  if (toolBlock && toolBlock.input && typeof toolBlock.input === 'object') {
    return { text: JSON.stringify(toolBlock.input), totalTokens };
  }

  // Fallback for provider drift: a plain text block parseJsonLoosely can rescue.
  const textBlock = json.content?.find((part) => part?.type === 'text');
  if (textBlock && typeof textBlock.text === 'string') {
    return { text: textBlock.text, totalTokens };
  }
  return null;
}

/**
 * Strip a ```json … ``` fence if the model wrapped its answer in one, then parse.
 * We ask for bare JSON, but models fence it anyway often enough that not handling
 * it would throw away otherwise-good answers. Returns null on anything unparseable.
 */
export function parseJsonLoosely(text: string): RawLlmResult | null {
  const trimmed = text.trim();
  // Peel a leading/trailing code fence (```json … ``` or plain ``` … ```).
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    // The result is an object with items/group — a bare array (or any non-object
    // JSON: a number, a string, null) is not the shape we asked for, so reject it
    // rather than let an array slip through the `typeof === 'object'` gap.
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as RawLlmResult;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Turn the model's items into trusted {@link VoiceExpenseItem}s. Anything whose
 * amount is not a finite number greater than zero is dropped rather than salvaged
 * — a bad amount is worse than a missing row, because the screen would file it.
 */
function mapItems(rawItems: unknown): VoiceExpenseItem[] {
  if (!Array.isArray(rawItems)) return [];
  const items: VoiceExpenseItem[] = [];
  for (const entry of rawItems as RawLlmItem[]) {
    const amountMajor = Number(entry?.amount);
    if (!Number.isFinite(amountMajor) || amountMajor <= 0) continue;
    // Only a three-letter code is a currency: the model sometimes answers with a
    // word ("rupees", "Rs"), which is not one — take it as "no currency named"
    // and let the screen fill the default rather than store a bad code.
    const rawCurrency = typeof entry?.currency === 'string' ? entry.currency.trim() : '';
    const currency = /^[a-z]{3}$/i.test(rawCurrency) ? rawCurrency.toUpperCase() : null;
    items.push({
      amountMajor,
      amountMinor: BigInt(Math.round(amountMajor * 100)),
      currency,
      note: String(entry?.note ?? '').trim(),
    });
  }
  return items;
}

/**
 * Resolve the model's group instruction to the app's {@link VoiceGroupTarget}.
 * An "existing" name is only honoured if it matches a real group by name,
 * case-insensitively and exactly; a made-up name resolves to null so the expense
 * lands in the capture inbox rather than in the wrong group. A "create" needs a
 * non-empty trimmed name. Everything else is null.
 */
export function mapGroup(rawGroup: unknown, groups: readonly VoiceGroupRef[]): VoiceGroupTarget {
  if (!rawGroup || typeof rawGroup !== 'object') return null;
  const group = rawGroup as RawLlmGroup;

  if (group.type === 'existing' && typeof group.name === 'string') {
    const wanted = group.name.trim().toLowerCase();
    const match = groups.find(
      (candidate) => candidate.name && candidate.name.trim().toLowerCase() === wanted,
    );
    return match ? { kind: 'existing', groupId: match.id } : null;
  }

  if (group.type === 'create' && typeof group.name === 'string') {
    // Cap a model-supplied new-group name so a runaway answer can't create a
    // group with an absurd name; truncate rather than reject so a merely verbose
    // one still works. Same ceiling the prompt truncates existing names to.
    const name = group.name.trim().slice(0, MAX_GROUP_NAME_CHARS);
    return name.length > 0 ? { kind: 'create', name } : null;
  }

  return null;
}

/**
 * Record what the call spent against the reader's usage counter, so the ceiling
 * they may have set (see aiSettings) actually counts model-powered voice parses.
 * Best-effort and self-contained: a storage hiccup here must not sink an
 * otherwise-good parse, so it is swallowed.
 */
async function noteUsage(totalTokens: number): Promise<void> {
  if (totalTokens <= 0) return;
  try {
    await addAiTokensUsed(totalTokens);
  } catch {
    // Usage accounting is a nicety, not a correctness requirement — never let it
    // turn a successful parse into a failure.
  }
}

/**
 * Interpret a spoken transcript with the reader's own model, or return null.
 *
 * Null means "the model tier could not help" for any reason — there is no key, the
 * key is a provider we do not recognise, the network failed, the provider said no,
 * the reply was not JSON, or the JSON carried nothing usable — and the caller then
 * falls back to the heuristic parser. It never throws.
 */
export async function interpretVoiceExpenses(
  transcript: string,
  ctx: VoiceLlmContext,
): Promise<VoiceParseResult | null> {
  const trimmed = transcript.trim();
  if (trimmed.length === 0) return null;
  // Bound the transcript before it leaves the device — a runaway body must not
  // inflate the request or its token cost.
  const text =
    trimmed.length > MAX_TRANSCRIPT_CHARS ? trimmed.slice(0, MAX_TRANSCRIPT_CHARS) : trimmed;

  const active = await getActiveAiKey();
  // No key means this whole tier is off — the heuristic is the only parser.
  if (!active) return null;

  try {
    const provider = aiProvider(active.id);
    const headers = provider.authHeaders(active.key);
    // Resolve settings/model (and any pre-flight async) BEFORE arming the abort
    // timer, so the timeout budget covers only the network round-trip — slow local
    // settings resolution must not eat into "the provider took too long".
    const model = await resolveModel(active.id);

    // Arm the timeout immediately before the call so it clocks only the fetch, and
    // clear it on every path out of the call (success, non-200, throw, abort).
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    let reply: ProviderReply | null;
    try {
      reply =
        active.id === 'anthropic'
          ? await callAnthropic(headers, model, ctx, text, controller.signal)
          : await callOpenAiCompatible(
              CHAT_URLS[active.id],
              headers,
              model,
              ctx,
              text,
              controller.signal,
            );
    } finally {
      clearTimeout(timeout);
    }
    if (!reply) return null;

    const parsed = parseJsonLoosely(reply.text);
    if (!parsed) return null;

    const items = mapItems(parsed.items);
    const group = mapGroup(parsed.group, ctx.groups);
    // Nothing to file and no group to make — let the heuristic have a go instead.
    if (items.length === 0 && group === null) return null;

    // The call earned its cost only once we know it produced something usable.
    await noteUsage(reply.totalTokens);

    // The model schema carries no split count; the screen matches spoken names
    // itself (see matchMemberNames), so null here is right, not a gap.
    return { items, group, splitCount: null };
  } catch (caught) {
    // Network error, abort/timeout, malformed body — all of it is a fallback, not
    // a crash. The raw error (scrubbed) goes to Sentry; the key and transcript do
    // not travel with it.
    reportHandled(caught, 'voice.llm');
    return null;
  }
}
