/**
 * The model tier of speak-an-expense, minus the model and the keystore.
 *
 * The three things worth pinning down without a device, a key, or a network:
 * that no key means no call at all (the heuristic owns that case), that a
 * well-formed provider reply is mapped into the right items and group, and that
 * every failure the network can hand back — a non-200, a thrown fetch — comes out
 * as null rather than an exception into the add-expense flow.
 *
 * aiKeys pulls in expo-secure-store, aiSettings pulls in async-storage, and
 * observability pulls in Sentry; none of that belongs in a pure unit test, so all
 * three are stubbed and the provider call is exercised through a stubbed fetch.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// Hoisted so the vi.mock factories below (which run before the imports) can close
// over them — vitest only allows a factory to reference names it created via
// vi.hoisted or names prefixed with "mock".
const { getActiveAiKeyMock, getAiSettingsMock, addAiTokensUsedMock } = vi.hoisted(() => ({
  getActiveAiKeyMock: vi.fn(),
  getAiSettingsMock: vi.fn(async () => ({
    enabled: true,
    model: null,
    tokenLimit: null,
    tokensUsed: 0,
  })),
  addAiTokensUsedMock: vi.fn(async () => {}),
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
  reportHandled: vi.fn(),
}));

import { interpretVoiceExpenses, type VoiceLlmContext } from '@/lib/voiceLlm';

const ctx: VoiceLlmContext = {
  groups: [
    { id: 'g-goa', name: 'Goa Trip' },
    { id: 'g-flat', name: 'Flat 4B' },
  ],
  locale: 'en',
  defaultCurrency: 'INR',
};

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

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  getActiveAiKeyMock.mockReset();
  addAiTokensUsedMock.mockClear();
});

describe('interpretVoiceExpenses', () => {
  it('returns null when no key is connected, without calling the network', async () => {
    getActiveAiKeyMock.mockResolvedValue(null);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    expect(await interpretVoiceExpenses('add 500 rupees to Goa trip', ctx)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
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
      { amountMajor: 500, amountMinor: 50000n, currency: 'INR', note: 'dinner' },
      { amountMajor: 20, amountMinor: 2000n, currency: null, note: 'tea' },
    ]);
    expect(result?.group).toEqual({ kind: 'existing', groupId: 'g-goa' });
    expect(result?.splitCount).toBeNull();
    // The reported usage tokens are recorded against the reader's counter.
    expect(addAiTokensUsedMock).toHaveBeenCalledWith(128);
  });

  it('reads a "create a new group" instruction', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [{ amount: 100, currency: 'INR', note: 'lunch' }],
      group: { type: 'create', name: '  Weekend  ' },
    });
    vi.stubGlobal('fetch', vi.fn(async () => openAiReply(content)));

    const result = await interpretVoiceExpenses('make a group weekend, 100 lunch', ctx);
    expect(result?.group).toEqual({ kind: 'create', name: 'Weekend' });
  });

  it('drops items with a non-positive or non-numeric amount', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({
      items: [
        { amount: 0, note: 'free' },
        { amount: 'abc', note: 'junk' },
        { amount: 12.5, currency: 'usd', note: 'snack' },
      ],
      group: null,
    });
    vi.stubGlobal('fetch', vi.fn(async () => openAiReply(content)));

    const result = await interpretVoiceExpenses('snack 12.5 dollars', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 12.5, amountMinor: 1250n, currency: 'USD', note: 'snack' },
    ]);
  });

  it('strips a code fence around the JSON before parsing', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const fenced = '```json\n' + JSON.stringify({ items: [{ amount: 5, note: 'chai' }], group: null }) + '\n```';
    vi.stubGlobal('fetch', vi.fn(async () => openAiReply(fenced)));

    const result = await interpretVoiceExpenses('chai 5', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 5, amountMinor: 500n, currency: null, note: 'chai' },
    ]);
  });

  it('returns null when nothing usable comes back (no items, no group)', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    const content = JSON.stringify({ items: [], group: null });
    vi.stubGlobal('fetch', vi.fn(async () => openAiReply(content)));

    expect(await interpretVoiceExpenses('hello there', ctx)).toBeNull();
  });

  it('returns null on a non-200 response', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'openai', key: 'sk-test' });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as unknown as Response),
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
  });

  it('sends an anthropic-shaped request for a Claude key and reads its content blocks', async () => {
    getActiveAiKeyMock.mockResolvedValue({ id: 'anthropic', key: 'sk-ant-test' });
    const fetchMock = vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({
            content: [{ type: 'text', text: JSON.stringify({ items: [{ amount: 9, note: 'bus' }], group: null }) }],
            usage: { input_tokens: 30, output_tokens: 12 },
          }),
        }) as unknown as Response,
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await interpretVoiceExpenses('bus 9', ctx);
    expect(result?.items).toEqual([
      { amountMajor: 9, amountMinor: 900n, currency: null, note: 'bus' },
    ]);
    // The Messages endpoint, with the browser-access header the RN runtime needs.
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect((init.headers as Record<string, string>)['anthropic-dangerous-direct-browser-access']).toBe(
      'true',
    );
    // input + output tokens summed for the usage counter.
    expect(addAiTokensUsedMock).toHaveBeenCalledWith(42);
  });
});
