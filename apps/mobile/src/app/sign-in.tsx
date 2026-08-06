/**
 * Getting in.
 *
 * Four ways, ordered by how little they ask for: carry on as a guest, a code
 * to a phone, a password, Google. ADR-006 is that nobody is made to register
 * before they can split a bill, so the guest button is not tucked away at the
 * bottom in small type.
 *
 * Which Supabase call each of these makes is decided in @baaki/core, not here.
 * A guest who taps "Google" must have Google *added* to the account they
 * already have — signing them in would create a different account and leave a
 * week of expenses on one they can no longer reach. That is easy to get wrong
 * in a screen and impossible to notice afterwards, so the screen does not get
 * to decide.
 */

import { useState } from 'react';
import Constants from 'expo-constants';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import { Button, Card, Chip, CurvedPanel, Row, Screen, Text, useTheme } from '@baaki/ui';

import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

type Mode = 'otp' | 'password';

export default function SignInScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { sendOtp, verifyOtp, continueAsGuest, withPassword, withGoogle, isGuest } = useAuth();
  const { height: screenHeight } = useWindowDimensions();

  /**
   * A guest arriving here is not choosing how to start — they already have an
   * account and are adding a way back into it. Showing them the welcome would
   * be asking a question they answered a week ago.
   */
  const [showOptions, setShowOptions] = useState(isGuest);
  const [mode, setMode] = useState<Mode>('otp');
  const [phone, setPhone] = useState('+91');
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [intent, setIntent] = useState<'sign_in' | 'sign_up'>('sign_in');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setBusy(false);
    }
  };

  /**
   * The welcome: the wordmark on a coloured sweep, one sentence, and the button
   * that gets somebody straight into a ledger. ADR-006 says nobody registers
   * before they can split a bill, so "carry on as a guest" *is* the primary
   * action here rather than the small print under a sign-up form.
   */
  if (!showOptions) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
        <CurvedPanel height={Math.min(screenHeight * 0.46, 420)}>
          <View
            style={{
              flex: 1,
              alignItems: 'center',
              justifyContent: 'center',
              paddingHorizontal: theme.spacing.xxxl,
              gap: theme.spacing.sm,
            }}
          >
            <Text
              style={{
                fontSize: 56,
                lineHeight: 72,
                fontWeight: '700',
                color: theme.color.onBrand,
              }}
            >
              பாக்கி
            </Text>
            <Text variant="caption" tone="onBrand" align="center">
              baaki · what is left over
            </Text>
          </View>
        </CurvedPanel>

        <View
          style={{
            flex: 1,
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.xxxl,
            gap: theme.spacing.lg,
          }}
        >
          <Text variant="display" align="center">
            Split anything{'\n'}with anyone
          </Text>
          <Text variant="body" tone="muted" align="center">
            {`${t.freeForever}. No account needed to start — add one later and everything you have entered comes with you.`}
          </Text>

          <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.md }}>
            <Button
              label="Start now"
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void run(continueAsGuest)}
            />
            <Button
              label="I already have an account"
              variant="ghost"
              fullWidth
              onPress={() => setShowOptions(true)}
            />
          </View>

          {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
          {error ? (
            <Text variant="caption" tone="negative" align="center">
              {error}
            </Text>
          ) : null}
        </View>

        <Text
          variant="micro"
          tone="faint"
          align="center"
          style={{ paddingBottom: theme.spacing.xxxl }}
        >
          Baaki {Constants.expoConfig?.version ?? ''}
        </Text>
      </View>
    );
  }

  return (
    <Screen edges={['bottom']}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{ paddingBottom: theme.spacing.xxxl }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <CurvedPanel height={180} curve={0.7}>
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center',
                gap: theme.spacing.xs,
              }}
            >
              <Text
                style={{
                  fontSize: 34,
                  lineHeight: 46,
                  fontWeight: '700',
                  color: theme.color.onBrand,
                }}
              >
                பாக்கி
              </Text>
              <Text variant="caption" tone="onBrand" align="center">
                {isGuest ? 'Keep this account on your next phone' : 'Welcome back'}
              </Text>
            </View>
          </CurvedPanel>

          <View style={{ gap: theme.spacing.xxl, paddingHorizontal: theme.spacing.xl }}>
            <Text variant="body" tone="muted" align="center">
              {isGuest
                ? 'Add a way to sign in, so this account is still yours on your next phone.'
                : 'Sign in however you set it up.'}
            </Text>

            <Card style={{ gap: theme.spacing.lg }}>
              <Row style={{ gap: theme.spacing.sm }}>
                <Chip
                  label="Send me a code"
                  selected={mode === 'otp'}
                  onPress={() => {
                    setMode('otp');
                    setError(null);
                  }}
                />
                <Chip
                  label="Use a password"
                  selected={mode === 'password'}
                  onPress={() => {
                    setMode('password');
                    setError(null);
                  }}
                />
              </Row>

              {mode === 'otp' && stage === 'phone' ? (
                <>
                  <Text variant="caption" tone="muted">
                    Phone number
                  </Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    accessibilityLabel="Phone number"
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 22,
                      fontWeight: '600',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Text variant="micro" tone="faint">
                    Start with your country code. Baaki never assumes +91 — a trip is exactly when
                    foreign numbers turn up.
                  </Text>
                  <Button
                    label="Send code"
                    size="lg"
                    fullWidth
                    disabled={busy || phone.trim().length < 8}
                    onPress={() =>
                      void run(async () => {
                        await sendOtp(phone.trim());
                        setStage('code');
                      })
                    }
                  />
                </>
              ) : null}

              {mode === 'otp' && stage === 'code' ? (
                <>
                  <Text variant="caption" tone="muted">
                    {`Code sent to ${phone}`}
                  </Text>
                  <TextInput
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    autoComplete="sms-otp"
                    accessibilityLabel="Verification code"
                    placeholder="123456"
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 28,
                      fontWeight: '700',
                      letterSpacing: 8,
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Button
                    label="Verify"
                    size="lg"
                    fullWidth
                    disabled={busy || code.trim().length < 4}
                    onPress={() => void run(() => verifyOtp(phone.trim(), code.trim()))}
                  />
                  <Button
                    label="Use a different number"
                    variant="ghost"
                    onPress={() => {
                      setStage('phone');
                      setCode('');
                    }}
                  />
                </>
              ) : null}

              {mode === 'password' ? (
                <>
                  <Text variant="caption" tone="muted">
                    Email or phone number
                  </Text>
                  {/* One field: "email or phone?" is a question the text already
                    answers. */}
                  <TextInput
                    value={identifier}
                    onChangeText={setIdentifier}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    autoComplete="username"
                    accessibilityLabel="Email or phone number"
                    placeholder="asha@example.com or +91…"
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 18,
                      fontWeight: '500',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Text variant="caption" tone="muted">
                    Password
                  </Text>
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoCapitalize="none"
                    autoComplete={intent === 'sign_up' ? 'new-password' : 'current-password'}
                    accessibilityLabel="Password"
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 18,
                      fontWeight: '500',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Text variant="micro" tone="faint">
                    Eight characters or more. A phrase you will remember beats a puzzle you will
                    not.
                  </Text>
                  <Button
                    label={
                      isGuest
                        ? 'Add this to my account'
                        : intent === 'sign_up'
                          ? 'Create account'
                          : 'Sign in'
                    }
                    size="lg"
                    fullWidth
                    disabled={busy || !identifier.trim() || password.length < 8}
                    onPress={() => void run(() => withPassword(identifier, password, intent))}
                  />
                  {/* A guest is never signing up or in — they are adding a way
                    back to the account they already have. */}
                  {isGuest ? null : (
                    <Button
                      label={
                        intent === 'sign_up'
                          ? 'I already have an account'
                          : 'I am new here — create an account'
                      }
                      variant="ghost"
                      onPress={() => {
                        setIntent(intent === 'sign_up' ? 'sign_in' : 'sign_up');
                        setError(null);
                      }}
                    />
                  )}
                </>
              ) : null}

              {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
              {error ? (
                <Text variant="caption" tone="negative">
                  {error}
                </Text>
              ) : null}
            </Card>

            <Button
              label={isGuest ? 'Continue with Google' : 'Sign in with Google'}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void run(withGoogle)}
            />

            {/* ADR-006: nobody is forced to register before they can use Baaki.
              Still here, one step back from the welcome, for somebody who came
              looking for their account and decided not to bother. */}
            {isGuest ? null : (
              <Button
                label="Continue as guest"
                variant="ghost"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => void run(continueAsGuest)}
              />
            )}

            <Text variant="micro" tone="faint" align="center">
              {isGuest
                ? 'Everything you have already added stays exactly where it is. This only adds a way to sign back in.'
                : 'A guest account keeps everything on this device until you add a way to sign in. Your ledger is never held hostage.'}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
