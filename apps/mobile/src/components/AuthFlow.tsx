/**
 * Getting in — the shared machinery behind the login and the sign-up screens.
 *
 * There are two front doors, one file. `flow` decides which: `'login'` is the
 * screen a returning person lands on, and `'signup'` is the separate page behind
 * "Create account", where a new person picks how to start and where the guest
 * way in lives. Keeping both in one component is deliberate: the form underneath
 * is identical, and two copies of a login form is exactly how one drifts from
 * the other.
 *
 * The layout is a plain white sheet — a heading, the email-and-password fields,
 * the primary action, then the providers at the foot — the shape every mainstream
 * login uses (the reference here is Quizlet's). Above the providers sit two
 * passwordless conveniences that both mail a one-time code to whatever address is
 * in the field: "Email me a code" (sign in without a password) and, on the login
 * door, "Forgot password" (recover the same way). A tapped code carries a
 * one-minute resend cool-down so a frustrated tap cannot spray the mailbox.
 *
 * Which Supabase call each button makes is decided in @waves/core, not here. A
 * guest who taps a provider or types a password must have that way *added* to the
 * account they already have — signing them in fresh would strand a week of
 * expenses on an account they can no longer reach (ADR-006). The passwordless
 * email-code path cannot express that "add in place", so it is hidden for a guest
 * (`isGuest`): they upgrade with a password or a provider, never a fresh code.
 *
 * ADR-006 is that nobody is made to register before they can split a bill. The
 * guest button sits on the sign-up page, one tap behind "Create account" — still
 * not behind a form, still reachable before any detail is asked, but off the
 * login screen a returning member sees. (ADR-006 addendum — see the PR.)
 */

import { useEffect, useRef, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import { router } from 'expo-router';
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import { Button, Callout, directionalIcon, iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { SocialButton } from '@/components/SocialButton';
import { useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export type AuthFlowKind = 'login' | 'signup';

/** Which face the middle of the sheet is showing: the email-and-password form,
 *  or the one-time code the two passwordless links drop into. */
enum Stage {
  Form = 'form',
  Code = 'code',
}

/** A liberal check — enough to tell "this is an email, mail a code to it" from
 *  "this is a phone number or a username". The server is the real judge. */
function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

const RESEND_SECONDS = 60;

export function AuthFlow({ flow }: { flow: AuthFlowKind }) {
  const theme = useTheme();
  const { t } = useStrings();
  const { withPassword, withGoogle, withApple, sendEmailOtp, verifyEmailOtp, isGuest } = useAuth();

  const isSignup = flow === 'signup';
  const intent: 'sign_in' | 'sign_up' = isSignup ? 'sign_up' : 'sign_in';

  const [stage, setStage] = useState<Stage>(Stage.Form);
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [passwordShown, setPasswordShown] = useState(false);
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Seconds left on the resend cool-down; 0 means "you may send again". A ref
  // holds the interval so a second send does not stack timers.
  const [resendLeft, setResendLeft] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (tickRef.current) clearInterval(tickRef.current);
    };
  }, []);

  const startResendTimer = (): void => {
    if (tickRef.current) clearInterval(tickRef.current);
    setResendLeft(RESEND_SECONDS);
    tickRef.current = setInterval(() => {
      setResendLeft((left) => {
        if (left <= 1) {
          if (tickRef.current) clearInterval(tickRef.current);
          tickRef.current = null;
          return 0;
        }
        return left - 1;
      });
    }, 1000);
  };

  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(
        friendlyError(
          caught,
          t.signIn.couldNotSignIn,
          'auth.signIn',
          t.misc.connectionProblem,
          t.misc.tooManyTries,
        ),
      );
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  // Both passwordless links mail to the address in the field. If it is not an
  // email, say so rather than mailing nowhere.
  const mailCode = (): void => {
    if (!looksLikeEmail(identifier)) {
      setError(t.signIn.enterEmailFirst);
      return;
    }
    void run(async () => {
      await sendEmailOtp(identifier, isSignup);
      setCode('');
      setStage(Stage.Code);
      startResendTimer();
    });
  };

  const submitPassword = (): void => {
    void (async () => {
      const outcome = await run(() => withPassword(identifier, password, intent));
      // A confirmation mail went out — send them to check it rather than leave
      // them on a form that looks inert.
      if (outcome?.verifyEmail) {
        router.push({ pathname: '/verify-email', params: { email: outcome.verifyEmail } });
      }
    })();
  };

  const fieldStyle = {
    backgroundColor: theme.color.surfaceMuted,
    borderRadius: theme.radius.lg,
    paddingHorizontal: theme.spacing.lg,
  } as const;

  const title = isSignup ? t.signIn.createAccount : t.signIn.signInAction;

  return (
    <Screen edges={['top', 'bottom']} style={{ backgroundColor: theme.color.surface }}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        {/* Header: back on the leading side, language on the trailing side —
            reachable from the first frame for somebody who opened the app in a
            script they cannot read. */}
        <Row style={{ paddingHorizontal: theme.spacing.md, minHeight: 44 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.common.back}
            hitSlop={12}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))}
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
              color={theme.color.text}
            />
          </Pressable>
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={t.language}
            hitSlop={12}
            onPress={() => router.push('/language')}
            style={({ pressed }) => ({
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center',
              opacity: pressed ? 0.6 : 1,
            })}
          >
            <Ionicons name="globe-outline" size={iconSize.lg} color={theme.color.text} />
          </Pressable>
        </Row>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xxl,
            gap: theme.spacing.xl,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <Text
            style={{
              fontSize: 40,
              lineHeight: 48,
              fontWeight: '800',
              letterSpacing: -1,
              color: theme.color.text,
              marginTop: theme.spacing.sm,
            }}
          >
            {title}
          </Text>

          {/* The email/username field is always here; the password sits below it
              on the form face, and gives way to the code field once a code has
              been mailed. */}
          <View style={{ gap: theme.spacing.md }}>
            <View style={fieldStyle}>
              <TextInput
                value={identifier}
                onChangeText={setIdentifier}
                editable={stage === Stage.Form}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="email-address"
                autoComplete="username"
                accessibilityLabel={t.signIn.identifier}
                placeholder={t.signIn.identifier}
                placeholderTextColor={theme.color.textFaint}
                style={{
                  fontSize: 17,
                  fontWeight: '500',
                  color: theme.color.text,
                  paddingVertical: theme.spacing.lg,
                }}
              />
            </View>

            {stage === Stage.Form ? (
              <>
                <View style={fieldStyle}>
                  <Row style={{ alignItems: 'center' }}>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry={!passwordShown}
                      autoCapitalize="none"
                      autoComplete={isSignup ? 'new-password' : 'current-password'}
                      accessibilityLabel={t.signIn.password}
                      placeholder={t.signIn.password}
                      placeholderTextColor={theme.color.textFaint}
                      style={{
                        flex: 1,
                        fontSize: 17,
                        fontWeight: '500',
                        color: theme.color.text,
                        paddingVertical: theme.spacing.lg,
                      }}
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        passwordShown ? t.signIn.hidePassword : t.signIn.showPassword
                      }
                      onPress={() => setPasswordShown((shown) => !shown)}
                      hitSlop={12}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Ionicons
                        name={passwordShown ? 'eye-off-outline' : 'eye-outline'}
                        size={iconSize.lg}
                        color={theme.color.textMuted}
                      />
                    </Pressable>
                  </Row>
                </View>

                <Button
                  testID="auth-submit"
                  label={isGuest ? t.signIn.addToAccount : title}
                  size="lg"
                  fullWidth
                  disabled={busy || !identifier.trim() || password.length < 8}
                  onPress={submitPassword}
                />

                {/* Passwordless conveniences, hidden for a guest (a fresh code
                    cannot upgrade their account in place). "Forgot password" is
                    login-only; "Email me a code" is on both doors. */}
                {!isGuest ? (
                  <View style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                    {!isSignup ? (
                      <Pressable
                        testID="auth-forgot"
                        accessibilityRole="button"
                        onPress={mailCode}
                        disabled={busy}
                        hitSlop={8}
                        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                      >
                        <Text variant="subheading" style={{ color: theme.color.brand }}>
                          {t.signIn.forgotPassword}
                        </Text>
                      </Pressable>
                    ) : null}
                    <Button
                      testID="auth-email-code"
                      label={t.signIn.emailMeACode}
                      variant="secondary"
                      size="lg"
                      fullWidth
                      disabled={busy}
                      icon={
                        <Ionicons name="mail-outline" size={iconSize.md} color={theme.color.text} />
                      }
                      onPress={mailCode}
                    />
                  </View>
                ) : null}
              </>
            ) : (
              <>
                {/* The code face: what was mailed, where, and the way back. */}
                <Text variant="caption" tone="muted">
                  {t.signIn.emailCodeSentTo.replace('{value}', identifier.trim())}
                </Text>
                <View style={fieldStyle}>
                  <TextInput
                    testID="auth-code"
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    autoComplete="one-time-code"
                    accessibilityLabel={t.contact.verificationCode}
                    placeholder="123456"
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 28,
                      fontWeight: '700',
                      letterSpacing: 8,
                      color: theme.color.text,
                      paddingVertical: theme.spacing.md,
                    }}
                  />
                </View>
                <Button
                  testID="auth-verify"
                  label={t.signIn.verify}
                  size="lg"
                  fullWidth
                  disabled={busy || code.trim().length < 6}
                  onPress={() => void run(() => verifyEmailOtp(identifier, code))}
                />

                <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => {
                      setStage(Stage.Form);
                      setCode('');
                      setError(null);
                    }}
                    hitSlop={8}
                    style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                  >
                    <Text variant="subheading" tone="muted">
                      {t.signIn.usePasswordInstead}
                    </Text>
                  </Pressable>
                  <Pressable
                    testID="auth-resend"
                    accessibilityRole="button"
                    onPress={mailCode}
                    disabled={busy || resendLeft > 0}
                    hitSlop={8}
                    style={({ pressed }) => ({ opacity: pressed || resendLeft > 0 ? 0.5 : 1 })}
                  >
                    <Text
                      variant="subheading"
                      style={{
                        color: resendLeft > 0 ? theme.color.textFaint : theme.color.brand,
                      }}
                    >
                      {resendLeft > 0
                        ? t.signIn.resendIn.replace('{s}', String(resendLeft))
                        : t.signIn.resendCode}
                    </Text>
                  </Pressable>
                </Row>
              </>
            )}

            {error ? <Callout tone="negative">{error}</Callout> : null}
          </View>

          {/* Push the providers to the foot of the sheet the way the reference
              does — the account-you-already-have shortcuts sit apart from the
              form, under a seam. */}
          <View style={{ flex: 1 }} />

          <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
            <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
            <Text variant="caption" tone="muted">
              {t.signIn.or}
            </Text>
            <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
          </View>

          <View style={{ gap: theme.spacing.md }}>
            <SocialRow
              busy={busy}
              wording={isGuest || isSignup ? 'continue' : 'signIn'}
              onGoogle={() => void run(withGoogle)}
              onApple={() => void run(withApple)}
              t={t}
            />
            {/* Phone kept as a quiet way in — off the main path the reference
                shows, but not dropped. */}
            <Button
              label={t.signIn.continuePhone}
              variant="ghost"
              size="lg"
              fullWidth
              disabled={busy}
              icon={<Ionicons name="call-outline" size={iconSize.md} color={theme.color.brand} />}
              onPress={() => router.push('/phone')}
            />
            {/* ADR-006 addendum: the guest way in belongs to the sign-up page. */}
            {isSignup && !isGuest ? (
              <Button
                label={t.signIn.continueGuest}
                variant="ghost"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => router.push('/guest-welcome')}
              />
            ) : null}
          </View>

          <Text variant="micro" tone="muted" align="center">
            {isGuest ? t.signIn.guestFootnote : t.signIn.memberFootnote}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The provider way in — Google and Apple.
 *
 * Apple leads on iOS (its guidelines want it at least as prominent as the
 * others; App Store guideline 4.8 requires it alongside Google there); Google
 * leads elsewhere, where Apple is the browser fallback.
 *
 * "Sign in with" is reserved for the login screen, where it is true. On the
 * sign-up page — and for a guest attaching a way back into the groups already
 * on this phone — Google's own guidelines say to write "Continue with", because
 * the same button both makes an account and returns to one.
 */
function SocialRow({
  busy,
  wording,
  onGoogle,
  onApple,
  t,
}: {
  busy: boolean;
  wording: 'continue' | 'signIn';
  onGoogle: () => void;
  onApple: () => void;
  t: UiStrings;
}) {
  const carryOn = wording === 'continue';
  const google = (
    <SocialButton
      key="google"
      provider="google"
      label={carryOn ? t.signIn.continueGoogle : t.signIn.signInGoogle}
      disabled={busy}
      onPress={onGoogle}
    />
  );
  const apple = (
    <SocialButton
      key="apple"
      provider="apple"
      label={carryOn ? t.signIn.continueApple : t.signIn.signInApple}
      disabled={busy}
      onPress={onApple}
    />
  );
  return <>{Platform.OS === 'ios' ? [apple, google] : [google, apple]}</>;
}
