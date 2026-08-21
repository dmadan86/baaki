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
  Avatar,
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
  SectionHeader,
  Text,
  useTabBarClearance,
  useTheme,
} from '@waves/ui';

import { dialingCodeForCountry } from '@waves/core';

import { CountryCodePicker } from '@/components/CountryCodePicker';
import { friendlyError } from '@/lib/errors';
import { confirmContact, startAddingContact, ContactChannel } from '@/data/api';
import { deviceCountry, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

export default function AccountScreen() {
  const { profile } = useAuth();
  // The name field seeds from `profile` exactly once. Mount the form only once
  // there is a profile to seed from, keyed on its id, so a name that arrives
  // after the first paint is not left as an empty seed that Save would write
  // back over the real row.
  if (!profile) {
    return (
      <Screen>
        <View />
      </Screen>
    );
  }
  return <AccountForm key={profile.id} />;
}

function AccountForm() {
  const theme = useTheme();
  const clearance = useTabBarClearance();
  const { t } = useStrings();
  const { session, profile, isGuest, refresh, updateProfile, withGoogle } = useAuth();

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

  // The display name lives here now — "You" folded into "Your account", since
  // both were the same thing edited on two screens. Seeded once from the
  // profile; the key on this screen's owner keeps it honest across a swap.
  const [name, setName] = useState(profile?.display_name ?? '');
  const [nameStatus, setNameStatus] = useState<string | null>(null);

  const [channel, setChannel] = useState<ContactChannel>(ContactChannel.Email);
  const [value, setValue] = useState('');
  // The dial code is a control, not a prefix baked into the field: the phone's
  // region is a guess, wrong for anyone whose language is English (US) while
  // they sit in India. The field holds the local digits; this holds the country.
  const [phoneCountry, setPhoneCountry] = useState<string>(
    profile?.country_code ?? deviceCountry() ?? 'IN',
  );
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const existing =
    channel === ContactChannel.Email
      ? (session?.user.email ?? null)
      : (session?.user.phone ?? null);

  // A stable subtitle for the identity header: the account's own contact,
  // independent of which channel the form below is currently pointed at, so it
  // does not flip as the chips are toggled. Purely a label.
  const accountContact = session?.user.email ?? session?.user.phone ?? null;

  // The name shown in the header portrait, never blank — the same "You"
  // fallback the save path already uses, so the header agrees with the row.
  const displayName = name.trim() || t.account.you;

  // Which providers already sign this account in, so a linked one shows as done
  // rather than offering to link what is already linked. Adding one goes through
  // the same `withGoogle` the sign-in screen uses: for somebody
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
      setError(friendlyError(caught, t.couldNotSave, 'account.link'));
    } finally {
      setBusy(false);
    }
  };

  const nameDirty = name.trim() !== (profile?.display_name ?? '');

  const saveName = async (): Promise<void> => {
    setNameStatus(null);
    try {
      // Only the name. The empty name falls back to "You" so nobody is nameless.
      await updateProfile({ display_name: name.trim() || t.account.you });
      setNameStatus(t.account.saved);
    } catch (caught) {
      setNameStatus(friendlyError(caught, t.couldNotSave, 'account.saveName'));
    }
  };

  // One normalised form is validated, sent and confirmed, so the code always
  // goes to the address the confirmation is checked against. For a phone that is
  // the picked country's dial code plus the local digits typed in the field.
  const dialCode = dialingCodeForCountry(phoneCountry) ?? '';
  const normalised =
    channel === ContactChannel.Email ? value.trim() : `${dialCode}${value.replace(/[^\d]/g, '')}`;

  const looksValid =
    channel === ContactChannel.Email
      ? /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalised)
      : /^\+?[0-9]{8,15}$/.test(normalised);

  // Every text field on this screen wears the same skin — a filled, rounded
  // surface you can see and aim at — so a field never reads as static text and
  // the phone number sits flush against the dial-code chip beside it.
  const fieldStyle = {
    fontSize: 17,
    fontWeight: '600' as const,
    color: theme.color.text,
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.md,
    paddingHorizontal: theme.spacing.lg,
    paddingVertical: theme.spacing.md,
  };

  const send = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await startAddingContact(channel, normalised);
      setSent(true);
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'account.sendContact'));
    } finally {
      setBusy(false);
    }
  };

  const confirm = async (): Promise<void> => {
    setError(null);
    setBusy(true);
    try {
      await confirmContact(channel, normalised, code);
      await refresh();
      setDone(true);
      setSent(false);
      setCode('');
    } catch (caught) {
      setError(friendlyError(caught, t.couldNotSave, 'account.confirmContact'));
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

        {/* A calm identity header: the avatar and name give the screen a focal
            point that names whose account this is (Mobbin — Todoist, TheFork).
            It is a portrait, not a control — the name is edited in the field
            just below, and the initials fall back cleanly when there is no
            display name yet. */}
        <View
          style={{
            alignItems: 'center',
            gap: theme.spacing.sm,
            paddingTop: theme.spacing.sm,
          }}
        >
          <Avatar name={displayName} size={88} />
          <View style={{ alignItems: 'center', gap: theme.spacing.xs }}>
            <Text variant="title">{displayName}</Text>
            {accountContact ? (
              <Text variant="caption" tone="muted">
                {accountContact}
              </Text>
            ) : null}
          </View>
        </View>

        {/* Your name, and how you appear to everyone else. Folded in from the
            old "You" screen so the whole account lives on one page. Save appears
            only once the name has changed, so the resting screen is calm. */}
        <View style={{ gap: theme.spacing.md }}>
          <SectionHeader title={t.account.displayName} />
          <Card style={{ gap: theme.spacing.lg }}>
            <TextInput
              value={name}
              onChangeText={setName}
              accessibilityLabel={t.account.displayName}
              placeholder={t.common.yourName}
              placeholderTextColor={theme.color.textFaint}
              style={fieldStyle}
            />
            {nameDirty ? (
              <Button label={t.common.save} fullWidth onPress={() => void saveName()} />
            ) : null}
            {nameStatus ? (
              <Text
                variant="caption"
                tone={nameStatus === t.account.saved ? 'positive' : 'negative'}
              >
                {nameStatus}
              </Text>
            ) : null}
          </Card>
        </View>

        {/* The signed-in reassurance is gone: for a member it said nothing they
            did not already know. A guest, or somebody sent here by a limit, gets
            the one message that is actually actionable — as a Callout, the app's
            canonical shape for "read this". */}
        {isGuest || gateBody ? (
          <Callout tone="info" title={gateBody ? t.contact.gateTitle : undefined}>
            {gateBody ?? t.contact.guestBody}
          </Callout>
        ) : null}

        <View style={{ gap: theme.spacing.md }}>
          <SectionHeader title={t.contact.signInMethodsTitle} />
          {/* An email or phone, or a linked account — any of them signs you back
              in on another phone. */}
          <Card style={{ gap: theme.spacing.lg }}>
            <ChipRow<ContactChannel>
              value={channel}
              onChange={(next) => {
                // Not mid-request: switching the target while a code is in flight
                // would have confirm() check the code against a different address
                // than it was sent to.
                if (busy) return;
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
              {channel === ContactChannel.Email ? (
                <TextInput
                  value={value}
                  onChangeText={(next) => {
                    setValue(next);
                    setSent(false);
                    setDone(false);
                  }}
                  editable={!busy}
                  autoCapitalize="none"
                  autoComplete="email"
                  keyboardType="email-address"
                  accessibilityLabel={t.contact.emailAddress}
                  placeholder={t.contact.emailPlaceholder}
                  placeholderTextColor={theme.color.textFaint}
                  style={fieldStyle}
                />
              ) : (
                // The dial code is its own control; the field beside it holds
                // only local digits. This is the country-code picker the phone
                // flow was missing.
                <Row style={{ gap: theme.spacing.sm, alignItems: 'stretch' }}>
                  <CountryCodePicker
                    code={phoneCountry}
                    onChange={(next) => {
                      // Changing the dial code changes the number, so any code
                      // already sent no longer matches — drop back to sending.
                      // And never mid-request, for the same reason the channel
                      // switch is guarded.
                      if (busy) return;
                      setPhoneCountry(next);
                      setSent(false);
                      setDone(false);
                      setError(null);
                      setCode('');
                    }}
                  />
                  <TextInput
                    value={value}
                    onChangeText={(next) => {
                      setValue(next);
                      setSent(false);
                      setDone(false);
                    }}
                    editable={!busy}
                    autoComplete="tel"
                    keyboardType="phone-pad"
                    accessibilityLabel={t.contact.phoneNumber}
                    placeholder={t.contact.phonePlaceholder.replace('{code}', '').trim()}
                    placeholderTextColor={theme.color.textFaint}
                    style={[fieldStyle, { flex: 1 }]}
                  />
                </Row>
              )}
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
                  // The code has just arrived by SMS or email — let the OS offer
                  // the one-tap fill rather than making it be retyped by hand.
                  // `sms-otp` is Android's autofill hint; `oneTimeCode` is iOS's.
                  autoComplete="sms-otp"
                  textContentType="oneTimeCode"
                  accessibilityLabel={t.contact.verificationCode}
                  placeholder="123456"
                  placeholderTextColor={theme.color.textFaint}
                  style={[fieldStyle, { fontSize: 24, fontWeight: '700', letterSpacing: 6 }]}
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
              <Button
                label={t.contact.useDifferent}
                variant="ghost"
                onPress={() => setSent(false)}
              />
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
              Only Google today; the row is built to take more. Under the same
              heading, because it is another way into the same account. */}
          <Card style={{ gap: theme.spacing.md }}>
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
            </View>
          </Card>
        </View>

        <Text variant="micro" tone="muted" align="center">
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
  icon: 'logo-google';
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
        <Button
          label={linkLabel}
          size="sm"
          variant="secondary"
          disabled={busy}
          // 38pt on its own — hitSlop lifts the target over the 44 floor
          // without enlarging the small trailing pill.
          hitSlop={8}
          onPress={onLink}
        />
      )}
    </Row>
  );
}
