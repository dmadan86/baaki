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

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';

import {
  Button,
  Callout,
  Card,
  CurvedPanel,
  iconSize,
  Row,
  Screen,
  SegmentedTabs,
  Text,
  useTheme,
} from '@waves/ui';

import { dialingCodeForCountry } from '@waves/core';

import { CountryCodePicker } from '@/components/CountryCodePicker';
import { LanguagePicker } from '@/components/LanguagePicker';
import { Onboarding } from '@/components/Onboarding';
import { SocialButton } from '@/components/SocialButton';
import { deviceCountry, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

export type AuthFlowKind = 'login' | 'signup';

enum Mode {
  Otp = 'otp',
  Password = 'password',
}

const TOUR_KEY = 'baaki.onboarding_seen';

export function AuthFlow({ flow }: { flow: AuthFlowKind }) {
  const theme = useTheme();
  const { t } = useStrings();
  const { sendOtp, verifyOtp, continueAsGuest, withPassword, withGoogle, withApple, isGuest } =
    useAuth();
  const { height: screenHeight } = useWindowDimensions();

  const isSignup = flow === 'signup';

  /**
   * A guest arriving here is not choosing how to start — they already have an
   * account and are adding a way back into it. Showing them the welcome would
   * be asking a question they answered a week ago.
   */
  const [showOptions, setShowOptions] = useState(isGuest);

  /**
   * `null` until storage answers. Rendering the welcome while we find out would
   * show it for one frame and then yank it away, which reads as a glitch on the
   * very first screen of the app.
   *
   * The tour belongs to the login entry alone: the sign-up page is somewhere a
   * person navigates to on purpose, never the first thing the app shows, so it
   * never owes them the tour. A guest is not a first-time user either.
   */
  const [tourSeen, setTourSeen] = useState<boolean | null>(isGuest || isSignup ? true : null);

  useEffect(() => {
    if (tourSeen !== null) return;
    let cancelled = false;
    void AsyncStorage.getItem(TOUR_KEY)
      .then((value) => {
        if (!cancelled) setTourSeen(value === 'yes');
      })
      // Storage failing is not a reason to hold somebody at a blank screen.
      // Worst case they see the tour once more than they should.
      .catch(() => {
        if (!cancelled) setTourSeen(true);
      });
    return () => {
      cancelled = true;
    };
  }, [tourSeen]);

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

  const run = async (action: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      setError(friendlyError(caught, t.signIn.couldNotSignIn, 'auth.signIn'));
    } finally {
      setBusy(false);
    }
  };

  if (tourSeen === null) {
    return <View style={{ flex: 1, backgroundColor: theme.color.bg }} />;
  }

  if (!tourSeen) {
    return (
      <Onboarding
        onDone={() => {
          setTourSeen(true);
          // Not awaited: the tour is over the moment they say so, and a write
          // that fails costs them one repeat, not a stuck screen.
          void AsyncStorage.setItem(TOUR_KEY, 'yes').catch(() => {});
        }}
      />
    );
  }

  /**
   * The welcome: the wordmark on a coloured sweep, the language in the corner,
   * and the ways in beneath — the two providers first as full-width branded
   * rows, then "continue with phone", then a hairline and the email path, and
   * last the line to the other door. On the sign-up page the guest way sits
   * among them; on the login screen it does not.
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
              {isSignup ? t.signIn.splitAnything.replace('\n', ' ') : t.signIn.tagline}
            </Text>
          </View>
        </CurvedPanel>

        {/* The language sits in the corner of the hero — reachable from the
            first frame for somebody who opened the app in a script they cannot
            read, without taking a line in the action column. */}
        <View
          style={{
            position: 'absolute',
            top: Constants.statusBarHeight + theme.spacing.sm,
            right: theme.spacing.xl,
            zIndex: 10,
          }}
        >
          <LanguagePicker />
        </View>

        {/* A way back to the login screen from the sign-up page, in the opposite
            corner, so leaving is as reachable as the language. */}
        {isSignup ? (
          <View
            style={{
              position: 'absolute',
              top: Constants.statusBarHeight + theme.spacing.sm,
              left: theme.spacing.md,
              zIndex: 10,
            }}
          >
            <Button
              label={t.common.back}
              variant="ghost"
              size="sm"
              onPress={() => (router.canGoBack() ? router.back() : router.replace('/sign-in'))}
            />
          </View>
        ) : null}

        {/* Below the curve, the ways in — centred in the space the hero leaves.
            A ScrollView so a short screen scrolls rather than clipping. */}
        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            justifyContent: 'center',
            paddingHorizontal: theme.spacing.xxxl,
            paddingTop: theme.spacing.xxl,
            paddingBottom: theme.spacing.xl,
          }}
          showsVerticalScrollIndicator={false}
          keyboardShouldPersistTaps="handled"
        >
          <View style={{ gap: theme.spacing.xl }}>
            {/* The fastest way in goes first. Somebody who has a Google or an
                Apple account is one tap from being in, and every app that does
                this well puts that tap above the form rather than under it. */}
            <View style={{ gap: theme.spacing.md }}>
              <SocialRow
                busy={busy}
                wording={isSignup ? 'continue' : 'signIn'}
                onApple={() => void run(withApple)}
                onGoogle={() => void run(withGoogle)}
                t={t}
              />
              {/* Phone as its own top-level way in, like the reference concept:
                  a tap that drops straight into the code form rather than a tab
                  the person has to find inside a card about passwords. */}
              <Button
                label={t.signIn.continuePhone}
                size="lg"
                fullWidth
                disabled={busy}
                icon={
                  <Ionicons name="call-outline" size={iconSize.md} color={theme.color.onBrand} />
                }
                onPress={() => {
                  setMode(Mode.Otp);
                  setStage('phone');
                  setShowOptions(true);
                }}
              />
            </View>

            {/* A hairline either side of the label, not bare text — the seam
                between "one tap" above and "an email and a password" below. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
              <Text variant="caption" tone="muted">
                {t.signIn.or}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
            </View>

            <View style={{ gap: theme.spacing.sm }}>
              <Button
                label={t.signIn.continueEmail}
                variant="secondary"
                size="lg"
                fullWidth
                disabled={busy}
                icon={<Ionicons name="mail-outline" size={iconSize.md} color={theme.color.brand} />}
                onPress={() => {
                  setMode(Mode.Password);
                  setShowOptions(true);
                }}
              />
              {/* ADR-006 addendum: the guest way in lives on the sign-up page,
                  not the login screen — quieter than the account buttons, still
                  never behind a form. */}
              {isSignup ? (
                <Button
                  label={t.signIn.continueGuest}
                  variant="ghost"
                  size="lg"
                  fullWidth
                  disabled={busy}
                  onPress={() => void run(continueAsGuest)}
                />
              ) : null}
            </View>

            {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
            {error ? <Callout tone="negative">{error}</Callout> : null}

            {/* The line to the other door. Coming back to sign in and starting
                fresh are different errands; each screen names the one it is not. */}
            <Button
              label={isSignup ? t.signIn.haveAccount : t.signIn.createAccount}
              variant="ghost"
              fullWidth
              disabled={busy}
              onPress={() =>
                isSignup
                  ? router.canGoBack()
                    ? router.back()
                    : router.replace('/sign-in')
                  : router.push('/sign-up')
              }
            />

            <Text
              variant="micro"
              tone="faint"
              align="center"
              style={{ paddingTop: theme.spacing.xs }}
            >
              Waves {Constants.expoConfig?.version ?? ''}
            </Text>
          </View>
        </ScrollView>
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
                {isGuest
                  ? t.signIn.keepOnNextPhone
                  : isSignup
                    ? t.signIn.createAccount
                    : t.signIn.welcomeBack}
              </Text>
            </View>
          </CurvedPanel>

          <View style={{ gap: theme.spacing.xxl, paddingHorizontal: theme.spacing.xl }}>
            <Text variant="body" tone="muted" align="center">
              {isGuest ? t.signIn.guestAddWay : t.signIn.signInHowever}
            </Text>

            {/* Above the form rather than below it. A guest arrives straight
                here without passing the welcome, so this is their only sight of
                the chips before they are asked to read a form. */}
            <LanguagePicker />

            {/* The providers sit above the form here too. They were a row of
                small squares under it, which put the one-tap way in below a
                keyboard on every phone. */}
            <View style={{ gap: theme.spacing.md }}>
              <SocialRow
                busy={busy}
                wording={isGuest || isSignup ? 'continue' : 'signIn'}
                onApple={() => void run(withApple)}
                onGoogle={() => void run(withGoogle)}
                t={t}
              />
            </View>

            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
              <Text variant="caption" tone="muted">
                {t.signIn.or}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
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
                    onPress={() => void run(() => withPassword(identifier, password, intent))}
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
                variant="ghost"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => void run(continueAsGuest)}
              />
            ) : null}

            <Text variant="micro" tone="muted" align="center">
              {isGuest ? t.signIn.guestFootnote : t.signIn.memberFootnote}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

/**
 * The two providers, stacked, in the order this platform expects.
 *
 * Apple leads on iOS and Google on Android — not a style choice: on an iPhone
 * the Apple sheet is the one that needs no browser and no typing, and on
 * Android it is Google's. Putting the home platform's own account first is what
 * every well-made sign-in on either store does, and it is the difference
 * between one tap and one tap plus a web view.
 *
 * "Sign in with" is reserved for the login screen, where it is true. On the
 * sign-up page — and for a guest attaching a way back into the groups already
 * on this phone — both Apple's and Google's own guidelines say to write
 * "Continue with", because the same button both makes an account and returns to
 * one, and "sign in" would suggest landing somewhere else.
 */
function SocialRow({
  busy,
  wording,
  onApple,
  onGoogle,
  t,
}: {
  busy: boolean;
  wording: 'continue' | 'signIn';
  onApple: () => void;
  onGoogle: () => void;
  t: UiStrings;
}) {
  const carryOn = wording === 'continue';
  const apple = (
    <SocialButton
      key="apple"
      provider="apple"
      label={carryOn ? t.signIn.continueApple : t.signIn.signInApple}
      disabled={busy}
      onPress={onApple}
    />
  );
  const google = (
    <SocialButton
      key="google"
      provider="google"
      label={carryOn ? t.signIn.continueGoogle : t.signIn.signInGoogle}
      disabled={busy}
      onPress={onGoogle}
    />
  );
  return <>{Platform.OS === 'ios' ? [apple, google] : [google, apple]}</>;
}
