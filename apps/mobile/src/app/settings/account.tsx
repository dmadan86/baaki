/**
 * Adding your details, whenever you feel like it (ADR-006).
 *
 * Baaki asks for nothing to get started, so this screen exists for the moment
 * someone decides they want the account to outlive the phone. It attaches an
 * email or a phone number to the account they already have — it does not make
 * a new one, so everything entered as a guest comes with them.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

import {
  Badge,
  Button,
  Card,
  ChipRow,
  directionalIcon,
  IconButton,
  Row,
  Screen,
  Text,
  useTheme,
} from '@baaki/ui';

import { confirmContact, startAddingContact, type ContactChannel } from '@/data/api';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function AccountScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { session, isGuest, refresh } = useAuth();

  const [channel, setChannel] = useState<ContactChannel>('email');
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const existing =
    channel === 'email' ? (session?.user.email ?? null) : (session?.user.phone ?? null);

  const looksValid =
    channel === 'email'
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim())
      : /^\+?[0-9]{8,15}$/.test(value.trim().replace(/[\s-]/g, ''));

  const send = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await startAddingContact(channel, value);
      setSent(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await confirmContact(channel, value, code);
      await refresh();
      setDone(true);
      setSent(false);
      setCode('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen>
      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: theme.spacing.xxxl,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <IconButton label={t.common.back} onPress={() => router.back()}>
            <Ionicons name={directionalIcon('chevron-back')} size={20} color={theme.color.text} />
          </IconButton>
          <View style={{ flex: 1, alignItems: 'center' }}>
            <Text variant="heading">{t.contact.title}</Text>
          </View>
          <View style={{ width: 44 }} />
        </Row>

        <Card style={{ backgroundColor: theme.color.brandSoft, gap: theme.spacing.sm }}>
          <Row style={{ gap: theme.spacing.sm }}>
            {isGuest ? (
              <Badge label={t.common.guest} />
            ) : (
              <Badge label={t.contact.signedIn} tone="positive" />
            )}
          </Row>
          <Text variant="caption" tone="muted">
            {isGuest ? t.contact.guestBody : t.contact.memberBody}
          </Text>
        </Card>

        <Card style={{ gap: theme.spacing.lg }}>
          <ChipRow<ContactChannel>
            value={channel}
            onChange={(next) => {
              setChannel(next);
              setSent(false);
              setDone(false);
              setError(null);
              setValue('');
            }}
            options={[
              { value: 'email', label: t.contact.email },
              { value: 'phone', label: t.contact.phone },
            ]}
          />

          {existing ? (
            <Text variant="caption" tone="positive">
              {t.contact.alreadyAdded.replace('{value}', existing)}
            </Text>
          ) : null}

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="caption" tone="muted">
              {channel === 'email' ? t.contact.emailAddress : t.contact.phoneNumber}
            </Text>
            <TextInput
              value={value}
              onChangeText={(next) => {
                setValue(next);
                setSent(false);
                setDone(false);
              }}
              editable={!busy}
              autoCapitalize="none"
              autoComplete={channel === 'email' ? 'email' : 'tel'}
              keyboardType={channel === 'email' ? 'email-address' : 'phone-pad'}
              accessibilityLabel={
                channel === 'email' ? t.contact.emailAddress : t.contact.phoneNumber
              }
              placeholder={
                channel === 'email' ? t.contact.emailPlaceholder : t.contact.phonePlaceholder
              }
              placeholderTextColor={theme.color.textFaint}
              style={{
                fontSize: 18,
                fontWeight: '600',
                color: theme.color.text,
                paddingVertical: theme.spacing.sm,
              }}
            />
          </View>

          {sent ? (
            <View style={{ gap: theme.spacing.xs }}>
              <Text variant="caption" tone="muted">
                {channel === 'email' ? t.contact.codeEmailed : t.contact.codeTexted}
              </Text>
              <TextInput
                value={code}
                onChangeText={setCode}
                editable={!busy}
                keyboardType="number-pad"
                maxLength={6}
                accessibilityLabel={t.contact.verificationCode}
                placeholder="123456"
                placeholderTextColor={theme.color.textFaint}
                style={{
                  fontSize: 24,
                  fontWeight: '700',
                  letterSpacing: 6,
                  color: theme.color.text,
                  paddingVertical: theme.spacing.sm,
                }}
              />
            </View>
          ) : null}

          {busy ? <ActivityIndicator color={theme.color.brand} /> : null}

          <Button
            label={
              sent
                ? t.contact.confirm
                : channel === 'email'
                  ? t.contact.sendCodeEmail
                  : t.contact.sendCodePhone
            }
            size="lg"
            fullWidth
            disabled={busy || (sent ? code.trim().length < 6 : !looksValid)}
            onPress={() => void (sent ? confirm() : send())}
          />

          {sent ? (
            <Button label={t.contact.useDifferent} variant="ghost" onPress={() => setSent(false)} />
          ) : null}

          {done ? (
            <Text variant="caption" tone="positive">
              {t.contact.added}
            </Text>
          ) : null}
          {error ? (
            <Text variant="caption" tone="negative">
              {error}
            </Text>
          ) : null}
        </Card>

        <Text variant="micro" tone="faint" align="center">
          {t.contact.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}
