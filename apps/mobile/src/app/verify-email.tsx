/**
 * Check your inbox — where an email sign-up waits for the confirmation link.
 *
 * Supabase, with email confirmations on, makes an account but no session until
 * the link in the mail is followed. `withPassword` reports that case and the
 * sign-up form sends the person here with their address. When they follow the
 * link and come back, "I've confirmed" re-reads the session; the moment one
 * exists the auth gate takes them into the app, so there is nothing to route by
 * hand.
 *
 * Public (see `_layout`): there is no session yet, by definition. Hidden from
 * the tab bar like the other signed-out screens.
 *
 * NOTE — the copy here is hardcoded English, matching the rest of the entry
 * screens; the i18n pass comes with the wiring.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router, useLocalSearchParams } from 'expo-router';
import { ActivityIndicator, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button, Callout, directionalIcon, iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';
import { supabase } from '@/lib/supabase';

export default function VerifyEmailScreen() {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const { t } = useStrings();
  const { refresh } = useAuth();
  const params = useLocalSearchParams<{ email?: string }>();
  const email = typeof params.email === 'string' ? params.email : '';

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notYet, setNotYet] = useState(false);
  const [resent, setResent] = useState(false);

  // Re-read the session. If the link has been followed a session now exists and
  // the auth gate whisks them in; if not, say so gently rather than silently.
  const onContinue = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setNotYet(false);
    try {
      await refresh();
      const { data } = await supabase.auth.getSession();
      if (!data.session) setNotYet(true);
    } catch (caught) {
      setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.verifyEmail'));
    } finally {
      setBusy(false);
    }
  };

  const onResend = async (): Promise<void> => {
    if (!email) return;
    setBusy(true);
    setError(null);
    setResent(false);
    try {
      const { error: resendError } = await supabase.auth.resend({ type: 'signup', email });
      if (resendError) throw resendError;
      setResent(true);
    } catch (caught) {
      setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.verifyEmail'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen edges={['top', 'bottom']}>
      <View
        style={{
          flex: 1,
          paddingHorizontal: theme.spacing.xl,
          paddingBottom: insets.bottom + theme.spacing.xl,
          gap: theme.spacing.xl,
        }}
      >
        <Row style={{ paddingTop: theme.spacing.md }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/sign-up'))}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons
              name={directionalIcon('chevron-back')}
              size={iconSize.lg}
              color={theme.color.buttonPrimary}
            />
          </Pressable>
        </Row>

        {/* The hero: a mailbox and the ask, centred — the same shape the privacy
            and other entry screens open with. */}
        <View style={{ alignItems: 'center', gap: theme.spacing.md, paddingTop: theme.spacing.xl }}>
          <View
            style={{
              width: 96,
              height: 96,
              borderRadius: 48,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.color.brandSoft,
            }}
          >
            <Ionicons name="mail-unread-outline" size={44} color={theme.color.brand} />
          </View>
          <Text
            align="center"
            style={{
              fontSize: 30,
              lineHeight: 38,
              fontWeight: '800',
              letterSpacing: -0.5,
              color: theme.color.text,
            }}
          >
            Check your inbox
          </Text>
          <Text variant="body" tone="muted" align="center">
            {email
              ? `We sent a confirmation link to ${email}. Open it to finish setting up your account, then come back.`
              : 'We sent you a confirmation link. Open it to finish setting up your account, then come back.'}
          </Text>
        </View>

        {resent ? <Callout tone="positive">A new link is on its way.</Callout> : null}
        {notYet ? (
          <Callout tone="warning">
            Not confirmed yet. Open the link in the email, then tap continue.
          </Callout>
        ) : null}
        {error ? <Callout tone="negative">{error}</Callout> : null}

        <View style={{ flex: 1 }} />

        <View style={{ gap: theme.spacing.sm }}>
          <Button
            label="I've confirmed — continue"
            size="lg"
            fullWidth
            disabled={busy}
            onPress={() => void onContinue()}
          />
          <Button
            label="Resend the link"
            variant="ghost"
            size="lg"
            fullWidth
            disabled={busy || !email}
            onPress={() => void onResend()}
          />
        </View>
        {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
      </View>
    </Screen>
  );
}
