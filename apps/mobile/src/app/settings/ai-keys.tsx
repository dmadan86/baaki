/**
 * Bring your own key.
 *
 * One place to connect a single model account — OpenAI, Claude, or Kimi. The key
 * is pasted here, held encrypted in this phone's keystore, and used straight from
 * here to the provider it belongs to. Baaki never receives it. See {@link aiKeys}
 * for how it is held and why.
 *
 * Only one key is ever connected: a reader picks the account the AI features run
 * on, and choosing another replaces it. Today the screen only stores and proves a
 * key. The features that spend it — reading a receipt, turning a spoken sentence
 * into a split — are built on top of this, next.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, Alert, Linking, ScrollView, TextInput, View } from 'react-native';

import {
  Badge,
  Button,
  Callout,
  Card,
  ChipRow,
  directionalIcon,
  IconButton,
  iconSize,
  Row,
  Screen,
  Text,
  Toggle,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { useStrings, type UiStrings } from '@/i18n';
import { useAiAccess, type AiAccess } from '@/lib/aiAccess';
import { subscribeAiConfig } from '@/lib/aiEvents';
import {
  AI_PROVIDERS,
  aiProvider,
  defaultAiModel,
  getActiveAiKey,
  getAiKey,
  maskAiKey,
  removeAiKey,
  setActiveAiKey,
  validateAiKey,
  type AiProvider,
  type AiProviderId,
} from '@/lib/aiKeys';
import {
  getAiSettings,
  resetAiTokensUsed,
  setAiEnabled,
  setAiModel,
  setAiTokenLimit,
} from '@/lib/aiSettings';

export default function AiKeysScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const access = useAiAccess();

  // The rule made visible: on via a plan, on via your own key, or off until one
  // of those. A locked state reads as a prompt, not a wall, so it is tinted
  // brand rather than negative.
  const accessLine =
    access === 'paid'
      ? { text: t.aiKeys.accessPaid, tone: 'positive' as const }
      : access === 'byok'
        ? { text: t.aiKeys.accessByok, tone: 'positive' as const }
        : access === 'paused'
          ? { text: t.aiKeys.accessPaused, tone: 'warning' as const }
          : access === 'overlimit'
            ? { text: t.aiKeys.accessOverlimit, tone: 'warning' as const }
            : access === 'locked'
              ? { text: t.aiKeys.accessLocked, tone: 'info' as const }
              : null;

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.text}
            />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.aiKeys.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        {/* Where the reader stands: on via a plan, on via their own key, or off
            until one of those. This one line carries the screen's purpose, so
            there is no separate intro paragraph above it. */}
        {accessLine ? <Callout tone={accessLine.tone}>{accessLine.text}</Callout> : null}

        <KeyManager t={t} access={access} />

        {/* The one promise that matters: the key does not go to Baaki. */}
        <Callout tone="info">{t.aiKeys.onDevice}</Callout>
      </ScrollView>
    </Screen>
  );
}

type TestState = null | 'testing' | 'valid' | 'invalid' | 'unreachable';

/**
 * The single connected key: pick a provider, paste its key, prove it or forget
 * it. Because only one key is ever held, this is one card rather than one per
 * provider — the picker chooses which account to connect, and saving a different
 * one replaces whatever was connected before.
 */
function KeyManager({ t, access }: { t: UiStrings; access: AiAccess }) {
  const theme = useTheme();

  // The one connected provider and its key, held only as a mask for display —
  // the plaintext is read from the keystore at the moment it is needed and never
  // parked in state.
  const [active, setActive] = useState<{ id: AiProviderId; masked: string } | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Which provider the picker points at. Defaults to the connected one so the
  // screen opens on the account already in use.
  const [selectedId, setSelectedId] = useState<AiProviderId>(AI_PROVIDERS[0].id);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void getActiveAiKey()
      .then((found) => {
        if (!alive) return;
        if (found) {
          setActive({ id: found.id, masked: maskAiKey(found.key) });
          setSelectedId(found.id);
        }
      })
      .catch(() => {
        // A keystore read can fail. Say so plainly and still let the reader use
        // the field — never leave it disabled with no explanation, and never
        // surface the raw error.
        if (alive) setStatus(t.aiKeys.storeError);
      })
      .finally(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [t]);

  const provider = aiProvider(selectedId);
  const isActiveSelected = active?.id === selectedId;

  const selectProvider = (id: AiProviderId): void => {
    // While a save or a test is in flight the provider is fixed — switching it
    // mid-validation would let a result land against the wrong provider.
    if (busy) return;
    setSelectedId(id);
    setDraft('');
    setStatus(null);
    setTest(null);
  };

  const save = async (): Promise<void> => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setStatus(null);
    setTest(null);
    try {
      await setActiveAiKey(selectedId, key);
      setActive({ id: selectedId, masked: maskAiKey(key) });
      setDraft('');
      setStatus(t.aiKeys.saved);
      // The access line re-reads on its own — setActiveAiKey announces the change
      // to every subscriber (see useAiAccess / subscribeAiConfig).
    } catch {
      // Never surface the raw keystore error — a plain, safe line instead.
      setStatus(t.aiKeys.storeError);
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (): Promise<void> => {
    // Hold busy for the whole validation — field, save and the provider picker
    // are all disabled while it runs, so a late result cannot land against an
    // edited draft or a switched provider. Every exit clears busy and leaves a
    // settled test state.
    setBusy(true);
    setStatus(null);
    setTest('testing');
    try {
      // Test what is in the field if the reader has typed something; otherwise
      // the connected key, when the picker is on the connected provider.
      const candidate = draft.trim() || (isActiveSelected ? await getAiKey(selectedId) : null);
      if (!candidate) {
        setTest(null);
        return;
      }
      const result = await validateAiKey(selectedId, candidate);
      setTest(result.ok ? 'valid' : result.reason === 'invalid' ? 'invalid' : 'unreachable');
    } catch {
      // Only a keystore read of the saved key can throw here — validateAiKey
      // never rejects. Treat it as "couldn't check", not "key is bad".
      setTest('unreachable');
    } finally {
      setBusy(false);
    }
  };

  const confirmRemove = (): void => {
    if (!active) return;
    Alert.alert(t.aiKeys.removeConfirmTitle, t.aiKeys.removeConfirmBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.remove,
        style: 'destructive',
        onPress: () => {
          // removeAiKey announces the change itself (subscribeAiConfig), so the
          // access line re-reads without a callback here.
          void removeAiKey()
            .then(() => {
              setActive(null);
              setDraft('');
              setStatus(null);
              setTest(null);
            })
            .catch(() => setStatus(t.aiKeys.storeError));
        },
      },
    ]);
  };

  const testLine =
    test === 'testing'
      ? { text: t.aiKeys.testing, tone: 'muted' as const }
      : test === 'valid'
        ? { text: t.aiKeys.valid, tone: 'positive' as const }
        : test === 'invalid'
          ? { text: t.aiKeys.invalid, tone: 'negative' as const }
          : test === 'unreachable'
            ? {
                text: t.aiKeys.unreachable.replace('{provider}', provider.label),
                tone: 'muted' as const,
              }
            : null;

  return (
    <Card style={{ gap: theme.spacing.lg }}>
      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
          {t.aiKeys.chooseProvider.toUpperCase()}
        </Text>
        <ChipRow
          value={selectedId}
          onChange={selectProvider}
          options={AI_PROVIDERS.map((entry) => ({ value: entry.id, label: entry.label }))}
        />
      </View>

      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text variant="subheading">{provider.label}</Text>
          <Text variant="caption" tone="muted">
            {provider.family}
          </Text>
        </View>
        {isActiveSelected ? (
          <Badge
            label={access === 'paused' ? t.aiKeys.pausedBadge : t.aiKeys.configured}
            tone={access === 'paused' ? 'neutral' : 'positive'}
          />
        ) : null}
      </Row>

      {/* The connected key, when the picker is on it: recognisable, never usable.
          When the picker is on a different provider, a plain note that saving
          here trades the connected one away — the single-key rule made concrete. */}
      {isActiveSelected && active ? (
        <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
          {active.masked}
        </Text>
      ) : active ? (
        <Text variant="caption" tone="muted">
          {t.aiKeys.replaceNote.replace('{provider}', aiProvider(active.id).label)}
        </Text>
      ) : null}

      <TextInput
        value={draft}
        onChangeText={(next) => {
          setDraft(next);
          setTest(null);
          setStatus(null);
        }}
        editable={!busy && loaded}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
        accessibilityLabel={`${provider.label} ${t.aiKeys.keyLabel}`}
        placeholder={provider.placeholder}
        placeholderTextColor={theme.color.textFaint}
        style={{
          fontSize: 16,
          fontWeight: '600',
          color: theme.color.text,
          backgroundColor: theme.color.surfaceMuted,
          borderRadius: theme.radius.md,
          paddingHorizontal: theme.spacing.lg,
          paddingVertical: theme.spacing.md,
        }}
      />

      <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
        <Button
          label={t.common.save}
          size="sm"
          disabled={busy || draft.trim().length === 0}
          onPress={() => void save()}
        />
        <Button
          label={test === 'testing' ? t.aiKeys.testing : t.aiKeys.test}
          size="sm"
          variant="secondary"
          disabled={busy || test === 'testing' || (!isActiveSelected && draft.trim().length === 0)}
          onPress={() => void runTest()}
        />
        {isActiveSelected ? (
          <Button
            label={t.common.remove}
            size="sm"
            variant="ghostDanger"
            disabled={busy}
            onPress={confirmRemove}
          />
        ) : null}
        {busy ? <ActivityIndicator size="small" color={theme.color.brand} /> : null}
      </Row>

      {testLine ? (
        <Text variant="caption" tone={testLine.tone}>
          {testLine.text}
        </Text>
      ) : null}
      {status ? (
        <Text variant="caption" tone={status === t.aiKeys.saved ? 'positive' : 'negative'}>
          {status}
        </Text>
      ) : null}

      {/* Settings for the connected key — only meaningful once one is saved for
          the provider on screen. */}
      {isActiveSelected && active ? <KeySettings provider={provider} t={t} /> : null}

      <Row>
        <Text
          variant="caption"
          tone="brand"
          onPress={() => void Linking.openURL(provider.keysUrl)}
          accessibilityRole="link"
        >
          {t.aiKeys.getKey}
        </Text>
      </Row>
    </Card>
  );
}

/**
 * The connected key's controls, none of which touch the secret: switch it on or
 * off, choose the model it runs, cap the tokens it may spend, and see how many
 * it has spent. Each change writes straight through to {@link getAiSettings} and
 * announces, so the access line above re-reads without this holding the verdict
 * itself.
 */
function KeySettings({ provider, t }: { provider: AiProvider; t: UiStrings }) {
  const theme = useTheme();

  const [enabled, setEnabled] = useState(true);
  // The chosen model id, always one this provider offers — a stale id from a
  // previous provider is shown as that provider's default instead.
  const [model, setModel] = useState<string>(defaultAiModel(provider.id));
  // The limit is edited as text so the field can be emptied to mean "no limit".
  const [limitText, setLimitText] = useState('');
  const [used, setUsed] = useState(0);

  useEffect(() => {
    let alive = true;
    const read = (): void => {
      void getAiSettings().then((settings) => {
        if (!alive) return;
        setEnabled(settings.enabled);
        setModel(
          settings.model && provider.models.includes(settings.model)
            ? settings.model
            : defaultAiModel(provider.id),
        );
        setLimitText(settings.tokenLimit ? String(settings.tokenLimit) : '');
        setUsed(settings.tokensUsed);
      });
    };
    read();
    // Re-read when the config changes elsewhere — e.g. replacing the key resets
    // these settings, and this block stays mounted for the same provider.
    const unsubscribe = subscribeAiConfig(read);
    return () => {
      alive = false;
      unsubscribe();
    };
  }, [provider.id, provider.models]);

  const toggleEnabled = (next: boolean): void => {
    setEnabled(next);
    void setAiEnabled(next);
  };

  const chooseModel = (next: string): void => {
    setModel(next);
    void setAiModel(next);
  };

  const commitLimit = (): void => {
    const parsed = Number.parseInt(limitText.replace(/[^0-9]/g, ''), 10);
    const next = Number.isFinite(parsed) && parsed > 0 ? parsed : null;
    setLimitText(next ? String(next) : '');
    void setAiTokenLimit(next);
  };

  const reset = (): void => {
    setUsed(0);
    void resetAiTokensUsed();
  };

  const limit = Number.parseInt(limitText, 10);
  const usedLine =
    Number.isFinite(limit) && limit > 0
      ? t.aiKeys.usedOfLimit
          .replace('{used}', used.toLocaleString())
          .replace('{limit}', limit.toLocaleString())
      : t.aiKeys.usedTokens.replace('{used}', used.toLocaleString());

  return (
    <View
      style={{
        gap: theme.spacing.md,
        borderTopWidth: 1,
        borderTopColor: theme.color.border,
        paddingTop: theme.spacing.md,
      }}
    >
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <Text variant="caption">{t.aiKeys.useKey}</Text>
        <Toggle
          value={enabled}
          onValueChange={toggleEnabled}
          accessibilityLabel={t.aiKeys.useKey}
        />
      </Row>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
          {t.aiKeys.modelLabel.toUpperCase()}
        </Text>
        <ChipRow
          value={model}
          onChange={chooseModel}
          options={provider.models.map((id) => ({ value: id, label: id }))}
        />
      </View>

      <View style={{ gap: theme.spacing.sm }}>
        <Text variant="micro" tone="faint" style={{ letterSpacing: 0.8 }}>
          {t.aiKeys.limitLabel.toUpperCase()}
        </Text>
        <TextInput
          value={limitText}
          onChangeText={(next) => setLimitText(next.replace(/[^0-9]/g, ''))}
          onEndEditing={commitLimit}
          onBlur={commitLimit}
          keyboardType="number-pad"
          inputMode="numeric"
          accessibilityLabel={t.aiKeys.limitLabel}
          placeholder={t.aiKeys.noLimit}
          placeholderTextColor={theme.color.textFaint}
          style={{
            fontSize: 16,
            fontWeight: '600',
            color: theme.color.text,
            backgroundColor: theme.color.surfaceMuted,
            borderRadius: theme.radius.md,
            paddingHorizontal: theme.spacing.lg,
            paddingVertical: theme.spacing.md,
          }}
        />
        <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
          <Text variant="caption" tone="muted">
            {usedLine}
          </Text>
          {used > 0 ? (
            <Text variant="caption" tone="brand" onPress={reset} accessibilityRole="button">
              {t.aiKeys.resetUsage}
            </Text>
          ) : null}
        </Row>
      </View>
    </View>
  );
}
