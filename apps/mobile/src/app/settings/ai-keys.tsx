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
  useTabBarClearance,
  useTheme,
} from '@baaki/ui';

import { useStrings, type UiStrings } from '@/i18n';
import { useAiAccess } from '@/lib/aiAccess';
import {
  AI_PROVIDERS,
  aiProvider,
  getActiveAiKey,
  getAiKey,
  maskAiKey,
  removeAiKey,
  setActiveAiKey,
  validateAiKey,
  type AiProviderId,
} from '@/lib/aiKeys';

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

        <Text variant="caption" tone="muted">
          {t.aiKeys.intro}
        </Text>

        {/* Where the reader stands under the rule: on via a plan, on via their
            own key, or off until one of those. */}
        {accessLine ? <Callout tone={accessLine.tone}>{accessLine.text}</Callout> : null}

        <KeyManager t={t} />

        {/* The one promise that matters, in the app's canonical "read this"
            shape: the key does not go to Baaki. */}
        <Callout tone="info">{t.aiKeys.onDevice}</Callout>

        <Text variant="micro" tone="muted" align="center">
          {t.aiKeys.footnote}
        </Text>
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
function KeyManager({ t }: { t: UiStrings }) {
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
    void getActiveAiKey().then((found) => {
      if (!alive) return;
      if (found) {
        setActive({ id: found.id, masked: maskAiKey(found.key) });
        setSelectedId(found.id);
      }
      setLoaded(true);
    });
    return () => {
      alive = false;
    };
  }, []);

  const provider = aiProvider(selectedId);
  const isActiveSelected = active?.id === selectedId;

  const selectProvider = (id: AiProviderId): void => {
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
    } catch (caught) {
      setStatus(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const runTest = async (): Promise<void> => {
    // Test what is in the field if the reader has typed something; otherwise the
    // connected key, when the picker is on the connected provider. So "Test"
    // works both before saving a new key and after.
    const candidate = draft.trim() || (isActiveSelected ? await getAiKey(selectedId) : null);
    if (!candidate) return;
    setTest('testing');
    setStatus(null);
    const result = await validateAiKey(selectedId, candidate);
    setTest(result.ok ? 'valid' : result.reason === 'invalid' ? 'invalid' : 'unreachable');
  };

  const confirmRemove = (): void => {
    if (!active) return;
    const removeId = active.id;
    Alert.alert(t.aiKeys.removeConfirmTitle, t.aiKeys.removeConfirmBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.remove,
        style: 'destructive',
        onPress: () => {
          void removeAiKey(removeId).then(() => {
            setActive(null);
            setDraft('');
            setStatus(null);
            setTest(null);
          });
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
        <Text variant="micro" tone="muted">
          {t.aiKeys.oneKey}
        </Text>
      </View>

      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text variant="subheading">{provider.label}</Text>
          <Text variant="caption" tone="muted">
            {provider.family}
          </Text>
        </View>
        {isActiveSelected ? <Badge label={t.aiKeys.configured} tone="positive" /> : null}
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
