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
 * The layout is one sheet with one hierarchy: a title and a muted line, the
 * email-and-password card, the passwordless links as text under it ("Email me
 * a code" on both doors, "Forgot password" on the login door — both mail a
 * one-time code to the address in the field, with a one-minute resend cool-down
 * so a frustrated tap cannot spray the mailbox), then the single primary button.
 * The other ways in — Google, Apple, phone — sit at the foot as three icon
 * tiles under a seam. Exactly one full-width button on the screen, on purpose:
 * the previous sheet stacked six of them at the same weight and read as bloat.
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

import { useEffect, useRef, useState, type ComponentProps } from 'react';
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
import Animated, { FadeIn, useReducedMotion } from 'react-native-reanimated';

import { Button, Callout, directionalIcon, iconSize, Row, Screen, Text, useTheme } from '@waves/ui';

import { SocialTile } from '@/components/SocialTile';
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
  const reduceMotion = useReducedMotion();
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

  // One grouped card for the fields: a hairline frame, a hairline between the
  // rows, no filled slabs. The row height is fixed so the card does not breathe
  // when the platform's text input decides on its own padding.
  const cardStyle = {
    borderWidth: 1,
    borderColor: theme.color.border,
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.surface,
    overflow: 'hidden',
  } as const;
  const rowStyle = {
    height: 52,
    paddingHorizontal: theme.spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
  } as const;
  const inputStyle = {
    flex: 1,
    fontSize: 16,
    fontWeight: '500',
    color: theme.color.text,
    paddingVertical: 0,
  } as const;
  const hairline = { height: 1, backgroundColor: theme.color.border } as const;

  const title = isSignup ? t.signIn.createAccount : t.signIn.welcomeBack;
  const submitLabel = isGuest
    ? t.signIn.addToAccount
    : isSignup
      ? t.signIn.createAccount
      : t.signIn.signInAction;
  const subline = isGuest
    ? t.signIn.guestAddWay
    : isSignup
      ? t.signIn.signupSubline
      : t.signIn.loginSubline;

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
          <HeaderGlyph
            label={t.common.back}
            icon={directionalIcon('chevron-back')}
            onPress={() => (router.canGoBack() ? router.back() : router.replace('/welcome'))}
          />
          <View style={{ flex: 1 }} />
          <HeaderGlyph
            label={t.language}
            icon="globe-outline"
            onPress={() => router.push('/language')}
          />
        </Row>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            paddingHorizontal: theme.spacing.xxl,
            paddingTop: theme.spacing.lg,
            paddingBottom: theme.spacing.xxl,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          {/* Title and one muted line. 28/700 rather than a 40pt display: this
              is a form, not a poster. */}
          <View style={{ gap: theme.spacing.xs, marginBottom: theme.spacing.xxxl }}>
            <Text
              style={{
                fontSize: 28,
                lineHeight: 34,
                fontWeight: '700',
                letterSpacing: -0.4,
                color: theme.color.text,
              }}
            >
              {title}
            </Text>
            <Text variant="body" tone="muted">
              {subline}
            </Text>
          </View>

          {stage === Stage.Form ? (
            <Animated.View
              key="form"
              entering={reduceMotion ? undefined : FadeIn.duration(160)}
              style={{ gap: theme.spacing.lg }}
            >
              <View style={cardStyle}>
                <View style={rowStyle}>
                  <TextInput
                    value={identifier}
                    onChangeText={setIdentifier}
                    autoCapitalize="none"
                    autoCorrect={false}
                    keyboardType="email-address"
                    autoComplete="username"
                    accessibilityLabel={t.signIn.identifier}
                    placeholder={t.signIn.identifier}
                    placeholderTextColor={theme.color.textFaint}
                    style={inputStyle}
                  />
                </View>
                <View style={hairline} />
                <View style={rowStyle}>
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry={!passwordShown}
                    autoCapitalize="none"
                    autoComplete={isSignup ? 'new-password' : 'current-password'}
                    accessibilityLabel={t.signIn.password}
                    placeholder={t.signIn.password}
                    placeholderTextColor={theme.color.textFaint}
                    style={inputStyle}
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
                      size={iconSize.md}
                      color={theme.color.textMuted}
                    />
                  </Pressable>
                </View>
              </View>

              {/* Passwordless conveniences as text links on one row, not
                  buttons: "Forgot password" is login-only, "Email me a code" is
                  on both doors, neither is for a guest (a fresh code cannot
                  upgrade their account in place). */}
              {!isGuest ? (
                <Row
                  style={{
                    justifyContent: 'center',
                    alignItems: 'center',
                    gap: theme.spacing.sm,
                  }}
                >
                  {!isSignup ? (
                    <>
                      <TextLink testID="auth-forgot" onPress={mailCode} disabled={busy}>
                        {t.signIn.forgotPassword}
                      </TextLink>
                      {/* Decorative only: a screen reader should hear the two
                          links, not the dot that sits between them. */}
                      <Text
                        variant="caption"
                        tone="faint"
                        accessibilityElementsHidden
                        importantForAccessibility="no-hide-descendants"
                      >
                        ·
                      </Text>
                    </>
                  ) : null}
                  <TextLink testID="auth-email-code" onPress={mailCode} disabled={busy}>
                    {t.signIn.emailMeACode}
                  </TextLink>
                </Row>
              ) : null}

              <Button
                testID="auth-submit"
                label={submitLabel}
                size="lg"
                fullWidth
                disabled={busy || !identifier.trim() || password.length < 8}
                onPress={submitPassword}
              />
            </Animated.View>
          ) : (
            <Animated.View
              key="code"
              entering={reduceMotion ? undefined : FadeIn.duration(160)}
              style={{ gap: theme.spacing.lg }}
            >
              {/* The code face: what was mailed, where, and the way back. */}
              <Text variant="caption" tone="muted">
                {t.signIn.emailCodeSentTo.replace('{value}', identifier.trim())}
              </Text>
              <View style={cardStyle}>
                <View style={[rowStyle, { height: 64 }]}>
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
                      flex: 1,
                      fontSize: 28,
                      fontWeight: '700',
                      letterSpacing: 8,
                      color: theme.color.text,
                      paddingVertical: 0,
                    }}
                  />
                </View>
              </View>
              <Button
                testID="auth-verify"
                label={t.signIn.verify}
                size="lg"
                fullWidth
                disabled={busy || code.trim().length < 6}
                onPress={() => void run(() => verifyEmailOtp(identifier.trim(), code.trim()))}
              />
              <Row style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                <TextLink
                  tone="muted"
                  onPress={() => {
                    setStage(Stage.Form);
                    setCode('');
                    setError(null);
                  }}
                >
                  {t.signIn.usePasswordInstead}
                </TextLink>
                <TextLink
                  testID="auth-resend"
                  onPress={mailCode}
                  disabled={busy || resendLeft > 0}
                  tone={resendLeft > 0 ? 'faint' : 'brand'}
                >
                  {resendLeft > 0
                    ? t.signIn.resendIn.replace('{s}', String(resendLeft))
                    : t.signIn.resendCode}
                </TextLink>
              </Row>
            </Animated.View>
          )}

          {error ? (
            <View style={{ marginTop: theme.spacing.lg }}>
              <Callout tone="negative">{error}</Callout>
            </View>
          ) : null}

          <View style={{ flex: 1, minHeight: theme.spacing.xxxl }} />

          {/* The other ways in: a seam, then three equal tiles. Small enough to
              sit at the foot without piling up under the form. */}
          <View style={{ gap: theme.spacing.xl }}>
            <Row style={{ alignItems: 'center', gap: theme.spacing.md }}>
              <View style={[hairline, { flex: 1 }]} />
              <Text variant="caption" tone="muted">
                {t.signIn.orContinueWith}
              </Text>
              <View style={[hairline, { flex: 1 }]} />
            </Row>
            <SocialTiles
              busy={busy}
              onGoogle={() => void run(withGoogle)}
              onApple={() => void run(withApple)}
              onPhone={isSignup ? undefined : () => router.push('/phone')}
              t={t}
            />
            {/* ADR-006 addendum: the guest way in belongs to the sign-up page —
                a text link, one tap, still before any detail is asked. */}
            {isSignup && !isGuest ? (
              <View style={{ alignItems: 'center' }}>
                <TextLink
                  testID="auth-guest"
                  onPress={() => router.push('/guest-welcome')}
                  disabled={busy}
                >
                  {t.signIn.continueGuest}
                </TextLink>
              </View>
            ) : null}
            {/* The footnote belongs where a guest account is in play: the
                sign-up door (where one can be started) and the guest upgrade. A
                returning member has nothing to be told. */}
            {isGuest || isSignup ? (
              <Text variant="micro" tone="muted" align="center">
                {isGuest ? t.signIn.guestFootnote : t.signIn.memberFootnote}
              </Text>
            ) : null}
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/** A 44pt header glyph — back, language. */
function HeaderGlyph({
  label,
  icon,
  onPress,
}: {
  label: string;
  icon: ComponentProps<typeof Ionicons>['name'];
  onPress: () => void;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      hitSlop={12}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <Ionicons name={icon} size={iconSize.lg} color={theme.color.text} />
    </Pressable>
  );
}

/** An inline text action — the secondary weight on this sheet, never a button. */
function TextLink({
  children,
  onPress,
  disabled = false,
  tone = 'brand',
  testID,
}: {
  children: string;
  onPress: () => void;
  disabled?: boolean;
  tone?: 'brand' | 'muted' | 'faint';
  testID?: string;
}) {
  const theme = useTheme();
  const color =
    tone === 'brand'
      ? theme.color.brand
      : tone === 'muted'
        ? theme.color.textMuted
        : theme.color.textFaint;
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      onPress={onPress}
      disabled={disabled}
      hitSlop={8}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text variant="subheading" style={{ color }}>
        {children}
      </Text>
    </Pressable>
  );
}

/**
 * The tile row — Google, Apple, and phone on the login door only.
 *
 * Apple leads on iOS (its guidelines want it at least as prominent as the
 * others; App Store guideline 4.8 requires it alongside Google there); Google
 * leads elsewhere, where Apple is the browser fallback. Spoken labels are the
 * full "Continue with …" — Google's own wording for a button that both makes
 * an account and returns to one — and the visible caption is the one word.
 *
 * Phone is absent from sign-up on purpose. ADR-006 makes a number a way to keep
 * an account rather than a way to get one, so `auth.sms.enable_signup` is off
 * and `sendOtp` asks for no user to be created — a number nobody holds yet is
 * refused. Offering the tile on the sign-up door would advertise a door the
 * server does not open. Signing in with a number still reaches the same screen,
 * and so does a guest attaching one to the account they already have.
 */
function SocialTiles({
  busy,
  onGoogle,
  onApple,
  onPhone,
  t,
}: {
  busy: boolean;
  onGoogle: () => void;
  onApple: () => void;
  /** Omitted on the sign-up door, where a new number cannot make an account. */
  onPhone?: () => void;
  t: UiStrings;
}) {
  const theme = useTheme();
  const google = (
    <SocialTile
      key="google"
      testID="auth-google"
      provider="google"
      accessibilityLabel={t.signIn.continueGoogle}
      caption={t.signIn.providerGoogle}
      disabled={busy}
      onPress={onGoogle}
    />
  );
  const apple = (
    <SocialTile
      key="apple"
      testID="auth-apple"
      provider="apple"
      accessibilityLabel={t.signIn.continueApple}
      caption={t.signIn.providerApple}
      disabled={busy}
      onPress={onApple}
    />
  );
  const phone = onPhone ? (
    <SocialTile
      key="phone"
      testID="auth-phone"
      provider="phone"
      accessibilityLabel={t.signIn.continuePhone}
      caption={t.signIn.providerPhone}
      disabled={busy}
      onPress={onPhone}
    />
  ) : null;
  const order = Platform.OS === 'ios' ? [apple, google, phone] : [google, apple, phone];
  return (
    <Row style={{ justifyContent: 'center', gap: theme.spacing.xxl }}>{order.filter(Boolean)}</Row>
  );
}
