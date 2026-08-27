/**
 * The model tier of speak-an-expense, minus the model and the keystore.
 *
 * The things worth pinning down without a device, a key, or a network: that no
 * key means no call at all (the heuristic owns that case); that a well-formed
 * provider reply — OpenAI JSON, an Anthropic forced tool call, or a fenced/prose
 * rescue — is mapped into the right items and group; that every failure the
 * network can hand back (a non-200, a thrown fetch, a timeout, non-JSON) comes
 * out as null rather than an exception into the add-expense flow; and that the
 * prompt-size and name caps actually bound what leaves the device.
 *
 * aiKeys pulls in expo-secure-store, aiSettings pulls in async-storage, and
 * observability pulls in Sentry; none of that belongs in a pure unit test, so all
 * three are stubbed and the provider call is exercised through a stubbed fetch.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factories below (which run before the imports) can close
// over them — vitest only allows a factory to reference names it created via
// vi.hoisted or names prefixed with "mock".
const { getActiveAiKeyMock, getAiSettingsMock, addAiTokensUsedMock, reportHandledMock } =
  vi.hoisted(() => ({
    getActiveAiKeyMock: vi.fn(),
    getAiSettingsMock: vi.fn(),
    addAiTokensUsedMock: vi.fn(),
    reportHandledMock: vi.fn(),
  }));

vi.mock('@/lib/aiKeys', () => ({
  getActiveAiKey: getActiveAiKeyMock,
  // A minimal stand-in for the real provider record: the only surface voiceLlm
  // touches is authHeaders (and, via defaultAiModel, models).
  aiProvider: (id: string) => ({
    id,
    authHeaders: (key: string) => ({ Authorization: `Bearer ${key}` }),
    models: ['gpt-4o-mini'],
  }),
  defaultAiModel: () => 'gpt-4o-mini',
}));

vi.mock('@/lib/aiSettings', () => ({
  getAiSettings: getAiSettingsMock,
  addAiTokensUsed: addAiTokensUsedMock,
}));

vi.mock('@/lib/observability', () => ({
  reportHandled: reportHandledMock,
}));

import type { VoiceGroupRef } from '@/lib/voiceExpense';
import {
  interpretVoiceExpenses,
  MAX_GROUP_NAME_CHARS,
  MAX_GROUPS_IN_PROMPT,
  MAX_TRANSCRIPT_CHARS,
  mapGroup,
  parseJsonLoosely,
  REQUEST_TIMEOUT_MS,
  type VoiceLlmContext,
} from '@/lib/voiceLlm';

const ctx: VoiceLlmContext = {
  groups: [
    { id: 'g-goa', name: 'Goa Trip' },
    { id: 'g-flat', name: 'Flat 4B' },
  ],
  locale: 'en',
  defaultCurrency: 'INR',
};

const DEFAULT_SETTINGS = { enabled: true, model: null, tokenLimit: null, tokensUsed: 0 };

/** An OpenAI chat/completions reply whose message content is the given JSON string. */
function openAiReply(content: string, usageTokens = 42): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      choices: [{ message: { content } }],
      usage: { total_tokens: usageTokens },
    }),
  } as unknown as Response;
}

/** An Anthropic Messages reply carrying the answer in a forced tool-use block. */
function anthropicToolReply(input: unknown, inTok = 20, outTok = 10): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'tool_use', name: 'record_expenses', input }],
      usage: { input_tokens: inTok, output_tokens: outTok },
    }),
  } as unknown as Response;
}

/** An Anthropic reply that drifted back to a plain text block instead of a tool call. */
function anthropicTextReply(text: string, inTok = 5, outTok = 5): Response {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      content: [{ type: 'text', text }],
      usage: { input_tokens: inTok, output_tokens: outTok },
    }),
  } as unknown as Response;
}

/** Parse the JSON request body of the first fetch call. */
function firstRequestBody(fetchMock: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
  return JSON.parse(init.body as string) as Record<string, unknown>;
}

/** The user turn's content from a parsed OpenAI/Anthropic request body. */
function userContent(body: Record<string, unknown>): string {
  const messages = body.messages as { role: string; content: string }[];
  return messages.find((m) => m.role === 'user')?.content ?? '';
}

beforeEach(() => {
  getActiveAiKeyMock.mockReset();
  getAiSettingsMock.mockReset().mockResolvedValue(DEFAULT_SETTINGS);
  addAiTokensUsedMock.mockReset().mockResolvedValue(undefined);
  reportHandledMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('parseJsonLoosely', () => {
  it('parses a bare JSON object', () => {
    expect(parseJsonLoosely('{"items":[],"group":null}')).toEqual({ items: [], group: null });
  });

  it('parses a ```json fenced object', () => {
    expect(parseJsonLoosely('```json\n{"group":null}\n```')).toEqual({ group: null });
  });

  it('parses a bare ``` fenced object', () => {
    expect(parseJsonLoosely('```\n{"group":null}\n```')).toEqual({ group: null });
  });

  it('rejects an array root (the result must be an object, not an array)', () => {
    expect(parseJsonLoosely('[1,2,3]')).toBeNull();
    expect(parseJsonLoosely('[{"amount":5}]')).toBeNull();
  });

  it('rejects prose before the JSON', () => {
    expect(parseJsonLoosely('Here you go: {"items":[]}')).toBeNull();
  });

  it('rejects malformed JSON', () => {
    expect(parseJsonLoosely('{"items": [}')).toBeNull();
  });

  it('rejects the empty string', () => {
    expect(parseJsonLoosely('')).toBeNull();
  });

  it('rejects a non-object JSON scalar', () => {
    expect(parseJsonLoosely('42')).toBeNull();
    expect(parseJsonLoosely('"hello"')).toBeNull();
    expect(parseJsonLoosely('null')).toBeNull();
  });
});

describe('mapGroup', () => {
  const groups: VoiceGroupRef[] = [
    { id: 'g-goa', name: 'Goa Trip' },
    { id: 'g-flat', name: 'Flat 4B' },
    { id: 'g-null', name: null },
  ];

  it('matches an existing group by exact name', () => {
    expect(mapGroup({ type: 'existing', name: 'Goa Trip' }, groups)).toEqual({
      kind: 'existing',
      groupId: 'g-goa',
    });
  });

  it('matches an existing group case-insensitively (and trims)', () => {
    expect(mapGroup({ type: 'existing', name: '  goa TRIP ' }, groups)).toEqual({
      kind: 'existing',
      groupId: 'g-goa',
    });
  });

  it('returns null for an unknown existing-group reference', () => {
    expect(mapGroup({ type: 'existing', name: 'Nowhere' }, groups)).toBeNull();
  });

  it('matches on the truncated prefix the prompt actually showed the model', () => {
    const longName = 'Weekend in ' + 'Coorg '.repeat(30); // well over MAX_GROUP_NAME_CHARS
    const withLong: VoiceGroupRef[] = [...groups, { id: 'g-long', name: longName }];
    const truncated = longName.slice(0, MAX_GROUP_NAME_CHARS);
    expect(mapGroup({ type: 'existing', name: truncated }, withLong)).toEqual({
      kind: 'existing',
      groupId: 'g-long',
    });
  });

  it('creates a group with a trimmed name', () => {
    expect(mapGroup({ type: 'create', name: '  Weekend  ' }, groups)).toEqual({
      kind: 'create',
      name: 'Weekend',
    });
  });

  it('returns null for an empty (whitespace-only) create-group name', () => {
    expect(mapGroup({ type: 'create', name: '   ' }, groups)).toBeNull();
    expect(mapGroup({ type: 'create', name: '' }, groups)).toBeNull();
  });

  it('caps an over-long create-group name to MAX_GROUP_NAME_CHARS', () => {
    const long = 'G'.repeat(MAX_GROUP_NAME_CHARS + 50);
    expect(mapGroup({ type: 'create', name: long }, groups)).toEqual({
      kind: 'create',
      name: 'G'.repeat(MAX_GROUP_NAME_CHARS),
    });
  });

  it('returns null for a non-object, null, or unknown-type group', () => {
    expect(mapGroup(null, groups)).toBeNull();
    expect(mapGroup('nope', groups)).toBeNull();
    expect(mapGroup({ type: 'other', name: 'x' }, groups)).toBeNull();
    expect(mapGroup({ type: 'existing', name: 42 }, groups)).toBeNull();
  });

  // No NFC/NFKC (or diacritic-folding) normalization exists in mapGroup today, and
  // the prompt-size scope this PR added deliberately did not introduce any — adding
  // it would be a silent matching-behavior change beyond the ask. A composed-vs-
  // decomposed name (e.g. "Café" vs "Café") would therefore not match today.
  it.todo('matches an existing group across unicode normalization forms (none today)');
});

describe('interpretVoiceExpenses', () => {
  it('returns null when no key is connected, without calling the network', async () => {
    getActiveAiKeyMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await interpretVoiceExpenses('add 500 rupees to Goa trip', ctx)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns null for an empty (whitespace-only) transcript, before any lookup', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await interpretVoiceExpenses('   ', ctx)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(getActiveAiKeyMock).not.toHaveBeenCalled();
  });

  it('maps a well-formed OpenAI-style reply into items and the matched group', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [
        { amount: 500, currency: 'INR', note: 'dinner' },
        { amount: 20, currency: null, note: 'tea' },
      ],
      group: { type: 'existing', name: 'goa trip' }, // case-insensitive match
    });
    const fetchMock = vi.fn(async () => openAiReply(content, 128));
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpretVoiceExpenses('500 dinner and 20 for tea, Goa trip', ctx);

    expect(result).not.toBeNull();
    expect(result?.items).toEqual([
      { amountMajor: 500, amountMinor: 50000n, currency: 'INR', note: 'dinner', category: null },
      { amountMajor: 20, amountMinor: 2000n, currency: null, note: 'tea', category: null },
    ]);
    expect(result?.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
    expect(result?.splitCount).toBeNull();
    // The reported usage tokens are recorded against the reader's counter.
    expect(addAiTokensUsedMock).toHaveBeenCalledWith(128);
    // OpenAI path forces a JSON object back.
    expect(firstRequestBody(fetchMock).response_format).toEqual({ type: 'json_object' });
  });

  it('reads a "create a new group" instruction with a trimmed name', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [{ amount: 100, currency: 'INR', note: 'lunch' }],
      group: { type: 'create', name: '  Weekend  ' },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    const result = await interpretVoiceExpenses('make a group weekend, 100 lunch', ctx);
    expect(result?.group).toEqual({ kind: 'create', name: 'Weekend' });
  });

  it('returns a group-only result when there are no items but a group to make', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({ items: [], group: { type: 'create', name: 'Goa' } });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    const result = await interpretVoiceExpenses('make a group called Goa', ctx);
    expect(result).toEqual({
      items: [],
      group: { kind: 'create', name: 'Goa' },
      splitCount: null,
      peopleText: null,
      expenseDate: null,
    });
  });

  it('drops items with a non-positive, non-numeric, or unsafe huge amount', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [
        { amount: 0, note: 'free' },
        { amount: 'abc', note: 'junk' },
        { amount: 1_000_000_001, currency: 'INR', note: 'too large' },
        { amount: 12.5, currency: 'usd', note: 'snack' },
      ],
      group: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    const result = await interpretVoiceExpenses('snack 12.5 dollars', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 12.5, amountMinor: 1250n, currency: 'USD', note: 'snack', category: null },
    ]);
  });

  it('uses real currency validation and currency-specific minor units for model items', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [
        { amount: 3000, currency: 'JPY', note: 'ramen' },
        { amount: 100000, currency: 'IDR', note: 'dinner' },
        { amount: 9, currency: 'ZZZ', note: 'unknown code' },
      ],
      group: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    const result = await interpretVoiceExpenses('3000 yen ramen, 100000 rupiah dinner', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 3000, amountMinor: 3000n, currency: 'JPY', note: 'ramen', category: null },
      { amountMajor: 100000, amountMinor: 10000000n, currency: 'IDR', note: 'dinner', category: null },
      { amountMajor: 9, amountMinor: 900n, currency: null, note: 'unknown code', category: null },
    ]);
  });

  it('caps model-supplied notes before returning them to the review UI', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const longNote = 'x'.repeat(200);
    const content = JSON.stringify({ items: [{ amount: 5, note: longNote }], group: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    const result = await interpretVoiceExpenses('5 for a long note', ctx);
    expect(result?.items[0]?.note).toBe('x'.repeat(160));
  });

  it('keeps the heuristic split metadata alongside model items', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [{ amount: 1000, currency: 'INR', note: 'dinner' }],
      group: null,
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    const result = await interpretVoiceExpenses(
      'split 1000 rupees among 4 people for dinner with Ravi yesterday category travel',
      ctx,
    );
    expect(result?.splitCount).toBe(4);
    expect(result?.peopleText).toBe('split 1000 rupees among 4 people for dinner with Ravi');
    expect(result?.expenseDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(result?.items[0].category).toBe('travel');
  });

  it('rejects unsupported negative or refund intents before key lookup or network calls', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    for (const sentence of [
      "don't add 500 rupees",
      'don’t add 500 rupees',
      'I did not pay 500 rupees',
      "I didn't pay 500 rupees",
      'I didn’t pay 500 rupees',
      'Ravi paid me back 500 rupees',
      'Ravi repaid 500 rupees',
      'Ravi repayment 500 rupees',
      'Ravi reimbursed me 500 rupees',
      'got paid back 500 rupees',
      'received money back 500 rupees',
    ]) {
      await expect(interpretVoiceExpenses(sentence, ctx), sentence).resolves.toBeNull();
    }
    expect(getActiveAiKeyMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('strips a code fence around the JSON before parsing', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const fenced =
      '```json\n' + JSON.stringify({ items: [{ amount: 5, note: 'chai' }], group: null }) + '\n```';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(fenced)),
    );

    const result = await interpretVoiceExpenses('chai 5', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 5, amountMinor: 500n, currency: null, note: 'chai', category: null },
    ]);
  });

  it('returns null when nothing usable comes back (no items, no group)', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({ items: [], group: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content)),
    );

    expect(await interpretVoiceExpenses('hello there', ctx)).toBeNull();
  });

  it('returns null when the provider returns non-JSON prose', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply('sorry, I could not parse that request')),
    );

    expect(await interpretVoiceExpenses('add 500 for dinner', ctx)).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response,
      ),
    );

    expect(await interpretVoiceExpenses('add 500 for dinner', ctx)).toBeNull();
  });

  it('returns null (never throws) when fetch rejects', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('network down');
      }),
    );

    await expect(interpretVoiceExpenses('add 500 for dinner', ctx)).resolves.toBeNull();
    expect(reportHandledMock).toHaveBeenCalled();
  });

  it('records token usage on a usable parse', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({ items: [{ amount: 7, note: 'bus' }], group: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content, 63)),
    );

    await interpretVoiceExpenses('bus 7', ctx);
    expect(addAiTokensUsedMock).toHaveBeenCalledWith(63);
  });

  it('still returns the parse when usage recording throws', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    addAiTokensUsedMock.mockRejectedValueOnce(new Error('storage full'));
    const content = JSON.stringify({ items: [{ amount: 7, note: 'bus' }], group: null });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => openAiReply(content, 55)),
    );

    const result = await interpretVoiceExpenses('bus 7', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 7, amountMinor: 700n, currency: null, note: 'bus', category: null },
    ]);
    // The recording was attempted, but its failure did not sink the parse.
    expect(addAiTokensUsedMock).toHaveBeenCalled();
    expect(reportHandledMock).not.toHaveBeenCalled();
  });
});

describe('interpretVoiceExpenses — the Anthropic tool path', () => {
  it('forces a tool call and parses the tool-use block into the shared shape', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'anthropic', key: 'sk-ant-test' });
    const fetchMock = vi.fn(async () =>
      anthropicToolReply(
        {
          items: [{ amount: 40, currency: 'INR', note: 'cab' }],
          group: { type: 'existing', name: 'Goa Trip' },
        },
        30,
        12,
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpretVoiceExpenses('cab 40 goa trip', ctx);
    // Contract parity with the OpenAI path: same VoiceParseResult shape.
    expect(result?.items).toEqual([
      { amountMajor: 40, amountMinor: 4000n, currency: 'INR', note: 'cab', category: null },
    ]);
    expect(result?.group).toEqual({ kind: 'existing', groupId: 'g-goa' });

    // The request hit the Messages endpoint, with the browser-access header the RN
    // runtime needs, and forced the single result tool.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(
      (init.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access'],
    ).toBe('true');
    const body = firstRequestBody(fetchMock);
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'record_expenses' });
    expect((body.tools as { name: string }[])[0].name).toBe('record_expenses');
    // input + output tokens summed for the usage counter.
    expect(addAiTokensUsedMock).toHaveBeenCalledWith(42);
  });

  it('still rescues a prose/fenced Anthropic text block via the fallback path', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'anthropic', key: 'sk-ant-test' });
    const fenced =
      '```json\n' + JSON.stringify({ items: [{ amount: 3, note: 'tea' }], group: null }) + '\n```';
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => anthropicTextReply(fenced)),
    );

    const result = await interpretVoiceExpenses('tea 3', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 3, amountMinor: 300n, currency: null, note: 'tea', category: null },
    ]);
  });

  it('returns null when Anthropic returns neither a tool call nor a text block', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'anthropic', key: 'sk-ant-test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          ({ ok: true, status: 200, json: async () => ({ content: [] }) }) as unknown as Response,
      ),
    );

    expect(await interpretVoiceExpenses('tea 3', ctx)).toBeNull();
  });
});

describe('interpretVoiceExpenses — prompt-size caps', () => {
  it('truncates an over-long transcript before sending it', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const fetchMock = vi.fn(async () =>
      openAiReply(JSON.stringify({ items: [{ amount: 1, note: 'x' }], group: null })),
    );
    vi.stubGlobal('fetch', fetchMock);

    const long = 'a'.repeat(MAX_TRANSCRIPT_CHARS + 500);
    await interpretVoiceExpenses(long, ctx);

    const sentTranscript = userContent(firstRequestBody(fetchMock)).split('Sentence:\n')[1];
    expect(sentTranscript.length).toBe(MAX_TRANSCRIPT_CHARS);
  });

  it('lists at most MAX_GROUPS_IN_PROMPT groups, in input order', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const many: VoiceGroupRef[] = Array.from({ length: MAX_GROUPS_IN_PROMPT + 25 }, (_, i) => ({
      id: `g-${i}`,
      name: `Group ${i}`,
    }));
    const fetchMock = vi.fn(async () =>
      openAiReply(JSON.stringify({ items: [{ amount: 1, note: 'x' }], group: null })),
    );
    vi.stubGlobal('fetch', fetchMock);

    await interpretVoiceExpenses('1 x', { ...ctx, groups: many });

    const listed = userContent(firstRequestBody(fetchMock))
      .split('\n')
      .filter((line) => line.startsWith('- '));
    expect(listed).toHaveLength(MAX_GROUPS_IN_PROMPT);
    expect(listed[0]).toBe('- Group 0');
    expect(listed[MAX_GROUPS_IN_PROMPT - 1]).toBe(`- Group ${MAX_GROUPS_IN_PROMPT - 1}`);
  });

  it('truncates a long group name in the prompt, and still matches when the model echoes that truncated form', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const longName = 'Trip ' + 'x'.repeat(MAX_GROUP_NAME_CHARS + 40);
    const truncated = longName.slice(0, MAX_GROUP_NAME_CHARS);
    const localGroups: VoiceGroupRef[] = [{ id: 'g-long', name: longName }];
    // The model can only ever see the truncated name in the prompt, so it echoes
    // the truncated form — the real-world case the prompt truncation creates.
    const fetchMock = vi.fn(async () =>
      openAiReply(
        JSON.stringify({
          items: [{ amount: 1, note: 'x' }],
          group: { type: 'existing', name: truncated },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpretVoiceExpenses('1 x', { ...ctx, groups: localGroups });

    // The prompt shows only the truncated name, never the full one...
    const sent = userContent(firstRequestBody(fetchMock));
    expect(sent).toContain('- ' + truncated);
    expect(sent).not.toContain(longName);
    // ...and the truncated echo still resolves to the real group via the prefix fallback.
    expect(result?.group).toEqual({ kind: 'existing', groupId: 'g-long' });
  });

  it('still matches a long group name when the model echoes the full stored name', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const longName = 'Trip ' + 'x'.repeat(MAX_GROUP_NAME_CHARS + 40);
    const localGroups: VoiceGroupRef[] = [{ id: 'g-long', name: longName }];
    // A model that happens to know the full name (e.g. from the transcript) still
    // matches via the exact full-name path.
    const fetchMock = vi.fn(async () =>
      openAiReply(
        JSON.stringify({
          items: [{ amount: 1, note: 'x' }],
          group: { type: 'existing', name: longName },
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpretVoiceExpenses('1 x', { ...ctx, groups: localGroups });
    expect(result?.group).toEqual({ kind: 'existing', groupId: 'g-long' });
  });
});

describe('interpretVoiceExpenses — abort timeout', () => {
  it('returns null and reports when the provider call times out', async () => {
    vi.useFakeTimers();
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    // A fetch that never resolves on its own — only the abort signal ends it.
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal as AbortSignal;
          if (signal.aborted) reject(new Error('aborted'));
          signal.addEventListener('abort', () => reject(new Error('aborted')));
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const promise = interpretVoiceExpenses('add 500 for dinner', ctx);
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS + 50);

    expect(await promise).toBeNull();
    expect(reportHandledMock).toHaveBeenCalled();
  });

  it('spends the timeout budget on the fetch, not on slow settings resolution', async () => {
    vi.useFakeTimers();
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    // getAiSettings takes far longer than the whole request timeout to resolve.
    getAiSettingsMock.mockImplementationOnce(
      () =>
        new Promise((resolve) =>
          setTimeout(() => resolve(DEFAULT_SETTINGS), REQUEST_TIMEOUT_MS * 2),
        ),
    );
    // A fetch that fails fast if it is ever handed an already-aborted signal —
    // which is exactly what a timer armed BEFORE settings resolution would do.
    const content = JSON.stringify({ items: [{ amount: 5, note: 'chai' }], group: null });
    const fetchMock = vi.fn((_url: string, init: RequestInit) => {
      const signal = init.signal as AbortSignal;
      if (signal.aborted) return Promise.reject(new Error('aborted before fetch'));
      return Promise.resolve(openAiReply(content));
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = interpretVoiceExpenses('chai 5', ctx);
    // Advance past the slow settings delay; the abort timer is only armed after it.
    await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS * 2 + 100);

    const result = await promise;
    expect(result?.items).toEqual([
      { amountMajor: 5, amountMinor: 500n, currency: null, note: 'chai', category: null },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(reportHandledMock).not.toHaveBeenCalled();
  });
});
