/**
 * Bring your own key.
 *
 * A place to paste a model API key — OpenAI, Claude, Kimi — that stays on this
 * phone, encrypted in its keystore, and is used straight from here to the
 * provider you chose. Baaki never receives it. See {@link aiKeys} for how it is
 * held and why.
 *
 * Today the screen only stores and proves a key. The features that spend it —
 * reading a receipt, turning a spoken sentence into a split — are built on top
 * of this, next.
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
  getAiKey,
  maskAiKey,
  removeAiKey,
  setAiKey,
  validateAiKey,
  type AiProvider,
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

        {/* The one promise that matters, in the app's canonical "read this"
            shape: the key does not go to Baaki. */}
        <Callout tone="info">{t.aiKeys.onDevice}</Callout>

        <View style={{ gap: theme.spacing.md }}>
          {AI_PROVIDERS.map((provider) => (
            <ProviderCard key={provider.id} provider={provider} t={t} />
          ))}
        </View>

        <Text variant="micro" tone="muted" align="center">
          {t.aiKeys.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}

type TestState = null | 'testing' | 'valid' | 'invalid' | 'unreachable';

/**
 * One provider: its saved key (masked), a field to paste a new one, and the two
 * things worth doing to a credential — prove it, or forget it.
 */
function ProviderCard({ provider, t }: { provider: AiProvider; t: UiStrings }) {
  const theme = useTheme();

  // The stored key, held only as a mask for display — the plaintext is read
  // from the keystore at the moment it is needed and never parked in state.
  const [masked, setMasked] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [test, setTest] = useState<TestState>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void getAiKey(provider.id).then((key) => {
      if (!active) return;
      setMasked(key ? maskAiKey(key) : null);
      setLoaded(true);
    });
    return () => {
      active = false;
    };
  }, [provider.id]);

  const save = async (): Promise<void> => {
    const key = draft.trim();
    if (!key) return;
    setBusy(true);
    setStatus(null);
    setTest(null);
    try {
      await setAiKey(provider.id, key);
      setMasked(maskAiKey(key));
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
    // key already saved. So "Test" works both before saving a new key and after.
    const candidate = draft.trim() || (await getAiKey(provider.id));
    if (!candidate) return;
    setTest('testing');
    setStatus(null);
    const result = await validateAiKey(provider.id, candidate);
    setTest(result.ok ? 'valid' : result.reason === 'invalid' ? 'invalid' : 'unreachable');
  };

  const confirmRemove = (): void => {
    Alert.alert(t.aiKeys.removeConfirmTitle, t.aiKeys.removeConfirmBody, [
      { text: t.common.cancel, style: 'cancel' },
      {
        text: t.common.remove,
        style: 'destructive',
        onPress: () => {
          void removeAiKey(provider.id).then(() => {
            setMasked(null);
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
    <Card style={{ gap: theme.spacing.md }}>
      <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
        <View>
          <Text variant="subheading">{provider.label}</Text>
          <Text variant="caption" tone="muted">
            {provider.family}
          </Text>
        </View>
        {masked ? <Badge label={t.aiKeys.configured} tone="positive" /> : null}
      </Row>

      {masked ? (
        <Text variant="caption" tone="muted" style={{ fontVariant: ['tabular-nums'] }}>
          {masked}
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
          disabled={busy || test === 'testing' || (!masked && draft.trim().length === 0)}
          onPress={() => void runTest()}
        />
        {masked ? (
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
