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
const REQUEST_TIMEOUT_MS = 8000;

/** A ceiling on the answer — a handful of expenses is plenty; runaway output is a bug. */
const MAX_TOKENS = 500;

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
    .filter((name): name is string => typeof name === 'string' && name.trim().length > 0);
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
  return settings.model ?? defaultAiModel(id);
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
 * Ask Anthropic, whose Messages API takes a top-level `system` and returns a
 * content-block array rather than a single string. The dangerous-direct-browser
 * header is required because this runs inside a React Native / webview runtime
 * that Anthropic treats as a browser origin.
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
    }),
  });
  if (!response.ok) return null;

  const json = (await response.json()) as {
    content?: { type?: string; text?: unknown }[];
    usage?: { input_tokens?: unknown; output_tokens?: unknown };
  };
  // The first text block is the answer; Anthropic can interleave other block
  // types, so we pick the text one rather than assuming index 0.
  const block = json.content?.find((part) => part?.type === 'text');
  if (!block || typeof block.text !== 'string') return null;

  const input = json.usage?.input_tokens;
  const output = json.usage?.output_tokens;
  const totalTokens =
    (typeof input === 'number' ? input : 0) + (typeof output === 'number' ? output : 0);
  return { text: block.text, totalTokens };
}

/**
 * Strip a ```json … ``` fence if the model wrapped its answer in one, then parse.
 * We ask for bare JSON, but models fence it anyway often enough that not handling
 * it would throw away otherwise-good answers. Returns null on anything unparseable.
 */
function parseJsonLoosely(text: string): RawLlmResult | null {
  const trimmed = text.trim();
  // Peel a leading/trailing code fence (```json … ``` or plain ``` … ```).
  const unfenced = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();
  try {
    const parsed = JSON.parse(unfenced) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as RawLlmResult;
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
    const currency =
      typeof entry?.currency === 'string' && entry.currency.trim().length > 0
        ? entry.currency.trim().toUpperCase()
        : null;
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
function mapGroup(rawGroup: unknown, groups: readonly VoiceGroupRef[]): VoiceGroupTarget {
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
    const name = group.name.trim();
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
  const text = transcript.trim();
  if (text.length === 0) return null;

  const active = await getActiveAiKey();
  // No key means this whole tier is off — the heuristic is the only parser.
  if (!active) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const provider = aiProvider(active.id);
    const headers = provider.authHeaders(active.key);
    const model = await resolveModel(active.id);

    const reply =
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
  } finally {
    clearTimeout(timeout);
  }
}
