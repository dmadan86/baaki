/**
 * Bring-your-own-key: the reader's own model API keys, kept on the device.
 *
 * A key here is a bearer credential to somebody's paid account, so it is held
 * the same way the session's refresh token is (see secureStorage) — in the OS
 * keystore (Keychain / Keystore) through expo-secure-store, which encrypts it at
 * rest and keeps it out of app-private plaintext and out of any backup. It is
 * never sent to a Baaki server: the only place it goes is straight from this
 * device to the provider the reader chose, over TLS. Baaki has no copy and no
 * way to get one.
 *
 * Keys are small (a couple of hundred characters at most), well under the
 * SecureStore per-item limit, so unlike the session they are stored whole rather
 * than chunked.
 *
 * These credentials are the groundwork for the model-powered features — reading
 * a receipt with a vision model, turning a spoken sentence into an expense with
 * the people and the split worked out — so that anyone can run those on their
 * own account and their own terms rather than on Baaki's. The vault and the
 * provider client are here; the features that call them come next.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { emitAiConfigChanged } from '@/lib/aiEvents';
import { resetAiSettings } from '@/lib/aiSettings';

export type AiProviderId = 'openai' | 'anthropic' | 'moonshot';

export interface AiProvider {
  id: AiProviderId;
  /** How the provider is named to the reader. */
  label: string;
  /** The model family, said plainly — "GPT", "Claude", "Kimi". */
  family: string;
  /** The shape a real key takes, shown greyed in the field. */
  placeholder: string;
  /** Where to get one. */
  keysUrl: string;
  /**
   * A cheap authenticated GET that answers "is this key real" without spending
   * anything. Each provider lists its models behind the same credential the
   * feature work will use, so a 200 here proves the key and the network path.
   */
  validateUrl: string;
  /** How this provider carries the key on a request. */
  authHeaders: (key: string) => Record<string, string>;
  /**
   * The models the reader may pick for this provider, cheapest/lightest first.
   * The first is the default. These are the ids a feature will pass to the
   * provider; the reader chooses one so the AI work runs on the model they want
   * to pay for.
   */
  models: readonly string[];
}

/** The default model for a provider — the first it lists. */
export function defaultAiModel(id: AiProviderId): string {
  return aiProvider(id).models[0];
}

/**
 * The providers offered today. The list is the only thing that has to grow to
 * offer another — everything downstream reads from it. Ordered by how likely a
 * reader is to already hold a key.
 */
export const AI_PROVIDERS: readonly AiProvider[] = [
  {
    id: 'openai',
    label: 'OpenAI',
    family: 'GPT',
    placeholder: 'sk-…',
    keysUrl: 'https://platform.openai.com/api-keys',
    validateUrl: 'https://api.openai.com/v1/models',
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    id: 'anthropic',
    label: 'Anthropic',
    family: 'Claude',
    placeholder: 'sk-ant-…',
    keysUrl: 'https://console.anthropic.com/settings/keys',
    validateUrl: 'https://api.anthropic.com/v1/models',
    authHeaders: (key) => ({ 'x-api-key': key, 'anthropic-version': '2023-06-01' }),
    models: ['claude-3-5-haiku-latest', 'claude-3-5-sonnet-latest', 'claude-3-opus-latest'],
  },
  {
    id: 'moonshot',
    label: 'Moonshot',
    family: 'Kimi',
    placeholder: 'sk-…',
    keysUrl: 'https://platform.moonshot.ai/console/api-keys',
    validateUrl: 'https://api.moonshot.ai/v1/models',
    authHeaders: (key) => ({ Authorization: `Bearer ${key}` }),
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k', 'kimi-k2-0711-preview'],
  },
];

export function aiProvider(id: AiProviderId): AiProvider {
  const found = AI_PROVIDERS.find((provider) => provider.id === id);
  // The id only ever comes from AI_PROVIDERS, so a miss is a programming error,
  // not a runtime one — fail loud rather than hand back a half-provider.
  if (!found) throw new Error(`unknown AI provider: ${id}`);
  return found;
}

const isWeb = Platform.OS === 'web';

/**
 * The one keystore entry the whole vault is: a single JSON record naming the
 * connected provider and holding its key. There is one key at a time, so it is
 * one entry — the active provider is written down, not inferred from which of
 * several records happens to exist. That makes connecting a key a single atomic
 * write (no set-then-sweep that could half-fail and leave two), and reading it
 * an unambiguous answer.
 */
const STORE_KEY = 'baaki.aikey';

interface StoredAiKey {
  id: AiProviderId;
  key: string;
}

/** Parse the stored record, trusting only a known provider id and a non-empty key. */
function parseStored(raw: string | null): StoredAiKey | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<StoredAiKey>;
    if (
      typeof parsed.key === 'string' &&
      parsed.key.length > 0 &&
      typeof parsed.id === 'string' &&
      AI_PROVIDERS.some((provider) => provider.id === parsed.id)
    ) {
      return { id: parsed.id as AiProviderId, key: parsed.key };
    }
  } catch {
    // A corrupt record reads as "no key" rather than throwing into the caller.
  }
  return null;
}

/**
 * The one provider connected right now, with its key — or null.
 *
 * This is the read the feature work does before a model request: it gets both
 * the credential and the provider whose endpoint and headers to use, from the
 * single stored record, with no in-memory cache of the plaintext to leak.
 */
export async function getActiveAiKey(): Promise<{ id: AiProviderId; key: string } | null> {
  if (isWeb) return null;
  return parseStored(await SecureStore.getItemAsync(STORE_KEY));
}

/**
 * The stored key for a provider, or null — non-null only for the connected
 * provider, since only one is ever held. Derived from the single record.
 */
export async function getAiKey(id: AiProviderId): Promise<string | null> {
  const active = await getActiveAiKey();
  return active && active.id === id ? active.key : null;
}

/**
 * Connect one provider, disconnecting any other.
 *
 * Baaki keeps a single model key at a time: a reader picks the account they want
 * the AI features to run on, not a pile of them. This is one write — the record
 * is replaced whole with the new provider and key — so there is never a moment
 * with two keys, and the trimmed key (a pasted one often is not) is what lands.
 */
export async function setActiveAiKey(id: AiProviderId, key: string): Promise<void> {
  if (isWeb) throw new Error('secure storage is unavailable on web');
  await SecureStore.setItemAsync(STORE_KEY, JSON.stringify({ id, key: key.trim() }));
  // A newly connected key is a fresh slate — on, no model override, no ceiling,
  // zero usage — so nothing from a previous key or account carries over.
  await resetAiSettings();
  emitAiConfigChanged();
}

/** Forget the connected key entirely, reset its settings, and announce. */
export async function removeAiKey(): Promise<void> {
  if (isWeb) return;
  await SecureStore.deleteItemAsync(STORE_KEY);
  // The settings belonged to that key — clear them so nothing carries to the next.
  await resetAiSettings();
  emitAiConfigChanged();
}

/**
 * The providers that currently hold a key on this device — zero or one, since
 * only one is ever connected. The AI access rule (see aiAccess) asks only "is
 * there any key", which this answers by length.
 */
export async function configuredAiProviders(): Promise<AiProviderId[]> {
  const active = await getActiveAiKey();
  return active ? [active.id] : [];
}

/**
 * A key shown back to its owner: enough to recognise which key it is, never
 * enough to use it or to reconstruct it over someone's shoulder. First few and
 * last four, the rest a fixed run of dots regardless of the true length so the
 * mask does not leak how long the secret is.
 */
export function maskAiKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 8) return '••••';
  return `${trimmed.slice(0, 3)}••••${trimmed.slice(-4)}`;
}

export interface KeyValidation {
  ok: boolean;
  /** 'invalid' when the provider rejected the key; 'network' when it could not be reached. */
  reason?: 'invalid' | 'network';
}

/**
 * Ask the provider whether a key is real, without spending anything.
 *
 * A 200 is a pass. A 401/403 is a genuine "this key is wrong" and is worth
 * saying. Anything else — a timeout, no signal, a provider outage — is not the
 * key's fault and must not be reported as one, so it comes back as 'network'
 * rather than 'invalid'. The key never touches a log or Sentry on any path.
 */
export async function validateAiKey(id: AiProviderId, key: string): Promise<KeyValidation> {
  const provider = aiProvider(id);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(provider.validateUrl, {
      method: 'GET',
      headers: provider.authHeaders(key.trim()),
      signal: controller.signal,
    });
    if (response.ok) return { ok: true };
    if (response.status === 401 || response.status === 403) {
      return { ok: false, reason: 'invalid' };
    }
    return { ok: false, reason: 'network' };
  } catch {
    return { ok: false, reason: 'network' };
  } finally {
    clearTimeout(timeout);
  }
}
