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
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, ScrollView, TextInput, View } from 'react-native';

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

import { confirmContact, startAddingContact, ContactChannel } from '@/data/api';
import { deviceDialingCode, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function AccountScreen() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { session, isGuest, refresh, withGoogle, withApple } = useAuth();

  // Set when a guest was sent here by a limit rather than arriving on their own
  // (ADR-006 addendum). It only changes the explainer at the top; the linking
  // below is the same either way.
  const { reason } = useLocalSearchParams<{ reason?: 'group_limit' | 'trial_expired' }>();
  const gateBody =
    reason === 'group_limit'
      ? t.contact.gateGroupBody
      : reason === 'trial_expired'
        ? t.contact.gateExpiredBody
        : null;

  const [channel, setChannel] = useState<ContactChannel>(ContactChannel.Email);
  const [value, setValue] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const existing =
    channel === ContactChannel.Email
      ? (session?.user.email ?? null)
      : (session?.user.phone ?? null);

  // Which providers already sign this account in, so a linked one shows as done
  // rather than offering to link what is already linked. Adding one goes through
  // the same `withGoogle`/`withApple` the sign-in screen uses: for somebody
  // already signed in, `planAuth` turns that into a link, never a fresh sign-in
  // that would strand this account (ADR-006).
  const linkedProviders = new Set(
    (session?.user.identities ?? []).map((identity) => identity.provider),
  );

  const link = async (start: () => Promise<void>): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await start();
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  const looksValid =
    channel === ContactChannel.Email
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
          paddingBottom: clearance,
          gap: theme.spacing.xl,
        }}
        keyboardShouldPersistTaps="handled"
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
          {gateBody ? (
            <Text variant="subheading" tone="brand">
              {t.contact.gateTitle}
            </Text>
          ) : null}
          <Text variant="caption" tone="muted">
            {gateBody ?? (isGuest ? t.contact.guestBody : t.contact.memberBody)}
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
              { value: ContactChannel.Email, label: t.contact.email },
              { value: ContactChannel.Phone, label: t.contact.phone },
            ]}
          />

          {existing ? (
            <Text variant="caption" tone="positive">
              {t.contact.alreadyAdded.replace('{value}', existing)}
            </Text>
          ) : null}

          <View style={{ gap: theme.spacing.xs }}>
            <Text variant="caption" tone="muted">
              {channel === ContactChannel.Email ? t.contact.emailAddress : t.contact.phoneNumber}
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
              autoComplete={channel === ContactChannel.Email ? 'email' : 'tel'}
              keyboardType={channel === ContactChannel.Email ? 'email-address' : 'phone-pad'}
              accessibilityLabel={
                channel === ContactChannel.Email ? t.contact.emailAddress : t.contact.phoneNumber
              }
              placeholder={
                channel === ContactChannel.Email
                  ? t.contact.emailPlaceholder
                  : t.contact.phonePlaceholder.replace('{code}', deviceDialingCode())
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
                {channel === ContactChannel.Email ? t.contact.codeEmailed : t.contact.codeTexted}
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
                : channel === ContactChannel.Email
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
          {error ? <Callout tone="negative">{error}</Callout> : null}
        </Card>

        {/* Linking a social account, so it can sign this same account in later
            on another phone — the OAuth complement to the email/phone above.
            Only Google and Apple today; the row is built to take more. */}
        <Card style={{ gap: theme.spacing.md }}>
          <Text variant="subheading">{t.contact.signInMethodsTitle}</Text>
          <Text variant="caption" tone="muted">
            {t.contact.signInMethodsBody}
          </Text>
          <View style={{ gap: theme.spacing.md }}>
            <ProviderRow
              name="Google"
              icon="logo-google"
              linked={linkedProviders.has('google')}
              busy={busy}
              linkLabel={t.contact.link}
              linkedLabel={t.contact.linked}
              onLink={() => void link(withGoogle)}
            />
            <ProviderRow
              name="Apple"
              icon="logo-apple"
              linked={linkedProviders.has('apple')}
              busy={busy}
              linkLabel={t.contact.link}
              linkedLabel={t.contact.linked}
              onLink={() => void link(withApple)}
            />
          </View>
        </Card>

        <Text variant="micro" tone="faint" align="center">
          {t.contact.footnote}
        </Text>
      </ScrollView>
    </Screen>
  );
}

/**
 * One provider in the "ways to sign in" list: its mark, its name, and either a
 * Linked badge or a button to link it. Icon-and-name so the row reads at a
 * glance; the action says exactly what it does.
 */
function ProviderRow({
  name,
  icon,
  linked,
  busy,
  linkLabel,
  linkedLabel,
  onLink,
}: {
  name: string;
  icon: 'logo-google' | 'logo-apple';
  linked: boolean;
  busy: boolean;
  linkLabel: string;
  linkedLabel: string;
  onLink: () => void;
}) {
  const theme = useTheme();
  return (
    <Row style={{ justifyContent: 'space-between' }}>
      <Row style={{ gap: theme.spacing.md }}>
        <Ionicons name={icon} size={iconSize.xl} color={theme.color.text} />
        <Text variant="body">{name}</Text>
      </Row>
      {linked ? (
        <Badge label={linkedLabel} tone="positive" />
      ) : (
        <Button label={linkLabel} size="sm" variant="secondary" disabled={busy} onPress={onLink} />
      )}
    </Row>
  );
}
