/**
 * Getting in — the shared machinery behind the login and the sign-up screens.
 *
 * There are two front doors now, one file. `flow` decides which: `'login'` is
 * the entry screen a returning person lands on (providers, phone, email — the
 * ways back into an account that exists), and `'signup'` is the separate page
 * behind "Create account", where a new person picks how to start and where the
 * guest way in lives. Keeping both in one component is deliberate: the OTP and
 * password forms underneath are identical, and two copies of a login form is
 * exactly how one drifts from the other.
 *
 * ADR-006 is that nobody is made to register before they can split a bill. The
 * guest button used to sit on the very first screen for that reason; it now
 * sits on the sign-up page instead, one tap behind "Create account" — still not
 * behind a form, still reachable before any detail is asked, but off the login
 * screen a returning member sees. (ADR-006 addendum — see the PR.)
 *
 * Which Supabase call each button makes is decided in @waves/core, not here. A
 * guest who taps "Google" must have Google *added* to the account they already
 * have — signing them in would create a different account and strand a week of
 * expenses on one they can no longer reach. That is easy to get wrong in a
 * screen and impossible to notice afterwards, so the screen does not decide.
 *
 * The language chip is here for the same reason the guest way is kept early:
 * this is the first screen, and the first screen has to work for somebody it
 * opened wrong. Waves follows the phone by default, and a phone is one setting
 * for one person — a shared handset, a borrowed one, or a person who reads Tamil
 * and set their phone up in English.
 */

import { useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import { Image } from 'expo-image';
import { router } from 'expo-router';
import Svg, { Path } from 'react-native-svg';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  View,
} from 'react-native';

import {
  Button,
  Callout,
  Card,
  CurvedPanel,
  directionalIcon,
  iconSize,
  Row,
  Screen,
  SegmentedTabs,
  Text,
  useTheme,
} from '@waves/ui';

import { dialingCodeForCountry } from '@waves/core';

import { CountryCodePicker } from '@/components/CountryCodePicker';
import { SocialButton } from '@/components/SocialButton';
import { deviceCountry, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export type AuthFlowKind = 'login' | 'signup';

enum Mode {
  Otp = 'otp',
  Password = 'password',
}

export function AuthFlow({ flow }: { flow: AuthFlowKind }) {
  const theme = useTheme();
  const { t } = useStrings();
  const { sendOtp, verifyOtp, withPassword, withGoogle, withApple, isGuest } = useAuth();

  const isSignup = flow === 'signup';

  /**
   * A guest arriving here is not choosing how to start — they already have an
   * account and are adding a way back into it. Showing them the welcome would
   * be asking a question they answered a week ago.
   */
  const [showOptions, setShowOptions] = useState(isGuest);

  // The dial code is a tappable country, not a prefix typed into the field. It
  // starts on the country this handset is set to — +971 in the UAE, +44 in the
  // UK — and falls back to India only when the region is unknown or unstocked,
  // because the picker beside it makes any wrong guess a one-tap fix rather than
  // a number to backspace over. The number field holds the local digits alone.
  const [country, setCountry] = useState<string>(() => {
    const guess = deviceCountry();
    return guess && dialingCodeForCountry(guess) ? guess : 'IN';
  });
  const dialCode = dialingCodeForCountry(country) ?? '+91';

  const [mode, setMode] = useState<Mode>(Mode.Otp);
  const [phone, setPhone] = useState('');
  // What actually goes to Supabase: the dial code and the local digits, no
  // spaces or punctuation — E.164 in all but the leading-zero rules the server
  // enforces. Display keeps the two apart; the wire joins them.
  const fullPhone = `${dialCode}${phone.replace(/\D/g, '')}`;
  const [code, setCode] = useState('');
  const [stage, setStage] = useState<'phone' | 'code'>('phone');
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [passwordShown, setPasswordShown] = useState(false);
  // The flow fixes the intent: the login screen only ever signs in, the sign-up
  // page only ever registers. The old in-form toggle is gone — the two doors are
  // the choice now.
  const intent: 'sign_in' | 'sign_up' = isSignup ? 'sign_up' : 'sign_in';
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async <T,>(action: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (caught) {
      setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.signIn'));
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  /**
   * The welcome: a round photo hero with a scribble, the value line in heavy
   * ink, the language in the corner, and the ways in beneath — Google first,
   * then "continue with email", then a hairline and the phone path, and last the
   * line to the other door. On the sign-up page the guest way sits among them; on
   * the login screen it does not.
   */
  if (!showOptions) {
    return (
      <View style={{ flex: 1, backgroundColor: theme.color.brand }}>
        {/* The language sits in the corner of the hero — reachable from the
            first frame for somebody who opened the app in a script they cannot
            read, without taking a line in the action column. */}
        <View
          style={{
            position: 'absolute',
            top: Constants.statusBarHeight + theme.spacing.sm,
            right: theme.spacing.sm,
            zIndex: 10,
          }}
        >
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
            <Ionicons name="globe-outline" size={iconSize.lg} color={theme.color.onBrand} />
          </Pressable>
        </View>

        {/* A way back to the welcome gateway, in the opposite corner from the
            language so leaving is as reachable. A chevron in the primary ink,
            shown on both doors — login and sign-up are both reached from the
            gateway, so both return to it. */}
        <View
          style={{
            position: 'absolute',
            top: Constants.statusBarHeight + theme.spacing.sm,
            left: theme.spacing.sm,
            zIndex: 10,
          }}
        >
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
              color={theme.color.onBrand}
            />
          </Pressable>
        </View>

        {/* Below the curve, the ways in — centred in the space the hero leaves.
            A ScrollView so a short screen scrolls rather than clipping. */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.xxxl,
            paddingTop: Constants.statusBarHeight + theme.spacing.xxxl,
            paddingBottom: theme.spacing.xl,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: theme.spacing.xl }}>
            {/* The hero: a round photo with a hand-drawn scribble tucked behind
                its shoulder, then the value line in heavy ink. This replaces the
                brand-wash panel — the way in is the screen now, not a banner over
                it. Placeholder photo (assets/images/auth-hero.jpg) and no Terms
                line yet; both are follow-ups. */}
            <AuthHero />
            <Text
              align="center"
              style={{
                fontSize: 30,
                lineHeight: 38,
                fontWeight: '800',
                letterSpacing: -0.5,
                color: theme.color.onBrand,
              }}
            >
              {t.signIn.splitAnything}
            </Text>

            {/* The fastest way in goes first. Somebody who has a Google account
                is one tap from being in, and every app that does this well puts
                that tap above the form rather than under it. */}
            <View style={{ gap: theme.spacing.md }}>
              <SocialRow
                busy={busy}
                wording={isSignup ? 'continue' : 'signIn'}
                onGoogle={() => void run(withGoogle)}
                onApple={() => void run(withApple)}
                t={t}
              />
              {/* Email as its own top-level way in: a tap that drops straight
                  into the email-and-password form rather than a tab the person
                  has to find inside a card. */}
              <Button
                label={t.signIn.continueEmail}
                variant="primary"
                size="lg"
                fullWidth
                disabled={busy}
                icon={
                  <Ionicons name="mail-outline" size={iconSize.md} color={theme.color.onBrand} />
                }
                onPress={() => {
                  setMode(Mode.Password);
                  setShowOptions(true);
                }}
              />
            </View>

            {/* A hairline either side of the label, not bare text — the seam
                between "one tap" above and "an email and a password" below. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View style={{ flex: 1, height: 1, backgroundColor: '#FFFFFF5C' }} />
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.9 }}>
                {t.signIn.or}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: '#FFFFFF5C' }} />
            </View>

            <View style={{ gap: theme.spacing.sm }}>
              {/* The phone way in, below the seam — the two email/phone ways in
                  read as one pair. */}
              <Button
                label={t.signIn.continuePhone}
                size="lg"
                fullWidth
                disabled={busy}
                icon={
                  <Ionicons name="call-outline" size={iconSize.md} color={theme.color.onBrand} />
                }
                onPress={() => router.push('/phone')}
              />
              {/* ADR-006 addendum: the guest way in lives on the sign-up page,
                  not the login screen — quieter than the account buttons, still
                  never behind a form. */}
              {isSignup ? (
                <Button
                  label={t.signIn.continueGuest}
                  variant="onBrandOutline"
                  size="lg"
                  fullWidth
                  disabled={busy}
                  onPress={() => router.push('/guest-welcome')}
                />
              ) : null}
            </View>

            {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
            {error ? <Callout tone="negative">{error}</Callout> : null}
          </View>
        </ScrollView>
      </View>
    );
  }

  return (
    <Screen edges={['bottom']} style={{ backgroundColor: theme.color.brand }}>
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
                {t.common.appName}
              </Text>
              <Text variant="caption" tone="onBrand" align="center">
                {isGuest
                  ? t.signIn.keepOnNextPhone
                  : isSignup
                    ? t.signIn.createAccount
                    : t.signIn.welcomeBack}
              </Text>
            </View>
          </CurvedPanel>

          <View style={{ gap: theme.spacing.xxl, paddingHorizontal: theme.spacing.xl }}>
            <Text variant="body" tone="onBrand" align="center" style={{ opacity: 0.9 }}>
              {isGuest ? t.signIn.guestAddWay : t.signIn.signInHowever}
            </Text>

            {/* Above the form rather than below it. A guest arrives straight
                here without passing the welcome, so this is their only sight of
                the language switch before they are asked to read a form — the
                same globe as the gateway, opening the full language screen. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={t.language}
              hitSlop={12}
              onPress={() => router.push('/language')}
              style={({ pressed }) => ({
                alignSelf: 'flex-end',
                width: 44,
                height: 44,
                alignItems: 'center',
                justifyContent: 'center',
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Ionicons name="globe-outline" size={iconSize.lg} color={theme.color.onBrand} />
            </Pressable>

            {/* The providers sit above the form here too. They were a row of
                small squares under it, which put the one-tap way in below a
                keyboard on every phone. */}
            <View style={{ gap: theme.spacing.md }}>
              <SocialRow
                busy={busy}
                wording={isGuest || isSignup ? 'continue' : 'signIn'}
                onGoogle={() => void run(withGoogle)}
                onApple={() => void run(withApple)}
                t={t}
              />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View style={{ flex: 1, height: 1, backgroundColor: '#FFFFFF5C' }} />
              <Text variant="caption" tone="onBrand" style={{ opacity: 0.9 }}>
                {t.signIn.or}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: '#FFFFFF5C' }} />
            </View>

            <Card style={{ gap: theme.spacing.lg }}>
              {/* Two ways in, named for what they ask for. The password face
                  says "email" out loud: somebody looking for an email field
                  should not have to guess it lives behind a tab about
                  passwords. */}
              <SegmentedTabs<Mode>
                value={mode}
                onChange={(next) => {
                  setMode(next);
                  setError(null);
                }}
                tabs={[
                  { value: Mode.Otp, label: t.signIn.sendMeACode },
                  { value: Mode.Password, label: t.signIn.useAPassword },
                ]}
              />

              {mode === Mode.Otp && stage === 'phone' ? (
                <>
                  <Text variant="caption" tone="muted">
                    {t.signIn.phoneNumber}
                  </Text>
                  {/* The code is its own control now — a tapped country, not a
                      prefix in the field — so the number beside it is just the
                      local digits. */}
                  <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                    <CountryCodePicker code={country} onChange={setCountry} />
                    <TextInput
                      value={phone}
                      onChangeText={setPhone}
                      keyboardType="phone-pad"
                      autoComplete="tel"
                      accessibilityLabel={t.signIn.phoneNumber}
                      placeholderTextColor={theme.color.textFaint}
                      style={{
                        flex: 1,
                        fontSize: 22,
                        fontWeight: '600',
                        color: theme.color.text,
                        paddingVertical: theme.spacing.sm,
                      }}
                    />
                  </Row>
                  <Text variant="micro" tone="muted">
                    {t.signIn.countryCodeHint}
                  </Text>
                  <Button
                    label={t.signIn.sendCode}
                    size="lg"
                    fullWidth
                    disabled={busy || phone.replace(/\D/g, '').length < 6}
                    onPress={() =>
                      void run(async () => {
                        await sendOtp(fullPhone);
                        setStage('code');
                      })
                    }
                  />
                </>
              ) : null}

              {mode === Mode.Otp && stage === 'code' ? (
                <>
                  <Text variant="caption" tone="muted">
                    {t.signIn.codeSentTo.replace('{value}', `${dialCode} ${phone}`)}
                  </Text>
                  <TextInput
                    value={code}
                    onChangeText={setCode}
                    keyboardType="number-pad"
                    autoComplete="sms-otp"
                    accessibilityLabel={t.contact.verificationCode}
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
                    label={t.signIn.verify}
                    size="lg"
                    fullWidth
                    disabled={busy || code.trim().length < 4}
                    onPress={() => void run(() => verifyOtp(fullPhone, code.trim()))}
                  />
                  <Button
                    label={t.signIn.differentNumber}
                    variant="ghost"
                    onPress={() => {
                      setStage('phone');
                      setCode('');
                    }}
                  />
                </>
              ) : null}

              {mode === Mode.Password ? (
                <>
                  <Text variant="caption" tone="muted">
                    {t.signIn.identifier}
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
                    accessibilityLabel={t.signIn.identifier}
                    placeholder={t.signIn.identifierPlaceholder.replace('{code}', dialCode)}
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 18,
                      fontWeight: '500',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Text variant="caption" tone="muted">
                    {t.signIn.password}
                  </Text>
                  {/* The eye is not a nicety on this field: the app asks for
                      eight characters, the keyboard is a phone keyboard, and a
                      password typed blind is the most common reason a correct
                      one is reported wrong. Every reference login has it.

                      The dots are the placeholder for the same reason: these
                      fields carry no border, so an empty one with no
                      placeholder reads as a gap rather than as somewhere to
                      type. Dots need no translating. */}
                  <Row style={{ gap: theme.spacing.sm, alignItems: 'center' }}>
                    <TextInput
                      value={password}
                      onChangeText={setPassword}
                      secureTextEntry={!passwordShown}
                      autoCapitalize="none"
                      autoComplete={intent === 'sign_up' ? 'new-password' : 'current-password'}
                      accessibilityLabel={t.signIn.password}
                      placeholder="••••••••"
                      placeholderTextColor={theme.color.textFaint}
                      style={{
                        flex: 1,
                        fontSize: 18,
                        fontWeight: '500',
                        color: theme.color.text,
                        paddingVertical: theme.spacing.sm,
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
                  <Text variant="micro" tone="muted">
                    {t.signIn.passwordHint}
                  </Text>
                  <Button
                    label={
                      isGuest
                        ? t.signIn.addToAccount
                        : intent === 'sign_up'
                          ? t.signIn.createAccount
                          : t.signIn.signInAction
                    }
                    size="lg"
                    fullWidth
                    disabled={busy || !identifier.trim() || password.length < 8}
                    onPress={() =>
                      void (async () => {
                        const outcome = await run(() => withPassword(identifier, password, intent));
                        // A confirmation mail went out — send them to check it
                        // rather than leave them on a form that looks inert.
                        if (outcome?.verifyEmail) {
                          router.push({
                            pathname: '/verify-email',
                            params: { email: outcome.verifyEmail },
                          });
                        }
                      })()
                    }
                  />
                </>
              ) : null}

              {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
              {error ? <Callout tone="negative">{error}</Callout> : null}
            </Card>

            {/* ADR-006 addendum: the guest way in belongs to the sign-up page.
                A guest reconnecting (isGuest) never needs it, and the login
                screen no longer carries it — so it shows only in the sign-up
                form, for somebody who came to register and changed their mind. */}
            {isSignup && !isGuest ? (
              <Button
                label={t.signIn.continueGuest}
                variant="onBrandOutline"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => router.push('/guest-welcome')}
              />
            ) : null}

            <Text variant="micro" tone="onBrand" align="center" style={{ opacity: 0.85 }}>
              {isGuest ? t.signIn.guestFootnote : t.signIn.memberFootnote}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The welcome hero: a round photo with a scribble tucked behind its shoulder.
 *
 * The photo is a placeholder stock shot (`assets/images/auth-hero.jpg`) — the
 * shape and the scribble are the design; the picture inside gets swapped for the
 * brand's own. The scribble is a single hand-drawn stroke in the brand's light
 * lilac, positioned to peek out from the top-right the way the reference does.
 */
const AUTH_HERO = require('../../assets/images/auth-hero.jpg');

function AuthHero() {
  const theme = useTheme();
  const size = 200;
  return (
    <View style={{ alignItems: 'center' }}>
      <View style={{ width: size, height: size }}>
        {/* Scribble first so the circle sits over its lower end, letting the
            stroke read as tucked *behind* the shoulder. */}
        <Svg
          width={size * 0.62}
          height={size * 0.5}
          viewBox="0 0 120 90"
          style={{ position: 'absolute', top: -10, right: -14 }}
        >
          <Path
            d="M8 70 C40 20 50 80 70 30 M20 78 C55 30 60 84 82 40 M34 82 C68 42 72 88 96 48"
            stroke="#B4A5FB"
            strokeWidth={7}
            strokeLinecap="round"
            fill="none"
          />
        </Svg>
        <View
          style={{
            width: size,
            height: size,
            borderRadius: size / 2,
            overflow: 'hidden',
            backgroundColor: theme.color.surfaceMuted,
          }}
        >
          <Image source={AUTH_HERO} style={{ width: '100%', height: '100%' }} contentFit="cover" />
        </View>
      </View>
    </View>
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
 * the same button both makes an account and returns to one, and "sign in" would
 * suggest landing somewhere else.
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
  // Apple's guidelines want its button at least as prominent as the others on
  // iOS, so it leads there; Google leads on every other platform, where Apple
  // is the browser fallback.
  return <>{Platform.OS === 'ios' ? [apple, google] : [google, apple]}</>;
}
