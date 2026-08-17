/**
 * Per-key settings for bring-your-own-key — everything about the connected key
 * that is *not* the secret itself.
 *
 * The key lives in the OS keystore (see aiKeys). These four preferences are not
 * secret — whether the key is switched on, which model to run, a token ceiling,
 * and how many tokens have been spent — so they live in ordinary storage, one
 * small JSON blob. A feature reads them before a model call: is the key on, what
 * model, is there budget left; and records what it spent afterwards
 * ({@link addAiTokensUsed}). Changing any of them announces through the shared
 * signal so the access verdict (see aiAccess) re-reads.
 *
 * There is one key at a time, so there is one set of settings. Replacing the key
 * with a different provider's is the moment the model no longer fits, so the
 * reader picks a model for the new provider then; a read that finds a model the
 * current provider does not offer falls back to that provider's default rather
 * than trusting a stale id.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { emitAiConfigChanged } from '@/lib/aiEvents';

export interface AiSettings {
  /** Whether the key may be used. Off pauses the AI features without deleting the key. */
  enabled: boolean;
  /** The chosen model id, or null to mean "the provider's default". */
  model: string | null;
  /** A ceiling on tokens spent, or null for no ceiling. */
  tokenLimit: number | null;
  /** Tokens spent so far, as recorded by the features. */
  tokensUsed: number;
}

const STORE_KEY = 'baaki.aisettings';

/** A key is usable by default — bringing it is the opt-in; the switch is a pause. */
const DEFAULTS: AiSettings = {
  enabled: true,
  model: null,
  tokenLimit: null,
  tokensUsed: 0,
};

/**
 * The current settings, defaults filled in for anything missing or unreadable.
 * Never throws — a corrupt or absent blob reads as the defaults so the screen
 * and the gate always have a complete answer.
 */
export async function getAiSettings(): Promise<AiSettings> {
  try {
    const raw = await AsyncStorage.getItem(STORE_KEY);
    if (!raw) return { ...DEFAULTS };
    const parsed = JSON.parse(raw) as Partial<AiSettings>;
    return {
      enabled: typeof parsed.enabled === 'boolean' ? parsed.enabled : DEFAULTS.enabled,
      model: typeof parsed.model === 'string' ? parsed.model : DEFAULTS.model,
      tokenLimit:
        typeof parsed.tokenLimit === 'number' && parsed.tokenLimit > 0
          ? parsed.tokenLimit
          : DEFAULTS.tokenLimit,
      tokensUsed:
        typeof parsed.tokensUsed === 'number' && parsed.tokensUsed >= 0
          ? parsed.tokensUsed
          : DEFAULTS.tokensUsed,
    };
  } catch {
    return { ...DEFAULTS };
  }
}

/** Read, apply the patch, write, announce. The one write path. */
async function patchAiSettings(patch: Partial<AiSettings>): Promise<void> {
  const next = { ...(await getAiSettings()), ...patch };
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(next));
  emitAiConfigChanged();
}

/** Turn the key on or off without deleting it. */
export async function setAiEnabled(enabled: boolean): Promise<void> {
  await patchAiSettings({ enabled });
}

/** Choose the model the features run. Pass null to fall back to the default. */
export async function setAiModel(model: string | null): Promise<void> {
  await patchAiSettings({ model });
}

/** Set a token ceiling, or null to lift it. Non-positive values lift it. */
export async function setAiTokenLimit(tokenLimit: number | null): Promise<void> {
  await patchAiSettings({
    tokenLimit: tokenLimit !== null && tokenLimit > 0 ? Math.floor(tokenLimit) : null,
  });
}

/** Record tokens a feature just spent. Additive, so concurrent calls do not lose counts. */
export async function addAiTokensUsed(tokens: number): Promise<void> {
  if (tokens <= 0) return;
  const current = await getAiSettings();
  await patchAiSettings({ tokensUsed: current.tokensUsed + Math.floor(tokens) });
}

/** Zero the usage counter — a new billing period, or just a fresh start. */
export async function resetAiTokensUsed(): Promise<void> {
  await patchAiSettings({ tokensUsed: 0 });
}

/**
 * Wipe every setting back to the defaults.
 *
 * The settings belong to whatever key is connected, so connecting a different
 * key — or removing the one there — is a clean slate: a switched-on key, no
 * model override, no ceiling, and a zeroed counter. Without this a new key on a
 * different account would inherit the previous account's usage, budget and even
 * a paused switch. Called from the vault's mutations (see aiKeys).
 */
export async function resetAiSettings(): Promise<void> {
  await AsyncStorage.setItem(STORE_KEY, JSON.stringify(DEFAULTS));
  emitAiConfigChanged();
}

/** Whether a ceiling exists and the count has reached it. */
export function isOverAiLimit(settings: AiSettings): boolean {
  return settings.tokenLimit !== null && settings.tokensUsed >= settings.tokenLimit;
}
