/**
 * Getting in.
 *
 * Five ways: Apple, Google, a code to a phone, an email and a password, or
 * nothing at all. They are ordered by how quickly they end — the two providers
 * first, because they are one tap and no typing, then email, then the guest
 * way. ADR-006 is that nobody is made to register before they can split a bill,
 * so the guest button is not tucked away at the bottom in small type.
 *
 * Which Supabase call each of these makes is decided in @baaki/core, not here.
 * A guest who taps "Google" must have Google *added* to the account they
 * already have — signing them in would create a different account and leave a
 * week of expenses on one they can no longer reach. That is easy to get wrong
 * in a screen and impossible to notice afterwards, so the screen does not get
 * to decide.
 *
 * The language chips are here for the same reason the guest button is: this is
 * the first screen, and the first screen has to work for somebody it opened
 * wrong. Baaki follows the phone by default, and a phone is one setting for one
 * person — a shared handset, a borrowed one, or simply a person who reads Tamil
 * and set their phone up in English. Making them sign in first, to reach a
 * settings row they cannot read, is a door that only opens from the inside.
 */

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Constants from 'expo-constants';
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
} from '@baaki/ui';

import { dialingCodeForCountry } from '@baaki/core';

import { CountryCodePicker } from '@/components/CountryCodePicker';
import { LanguagePicker } from '@/components/LanguagePicker';
import { Onboarding } from '@/components/Onboarding';
import { SocialButton } from '@/components/SocialButton';
import { deviceCountry, useStrings, type UiStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';
import { friendlyError } from '@/lib/errors';

enum Mode {
  Otp = 'otp',
  Password = 'password',
}

const TOUR_KEY = 'baaki.onboarding_seen';

export default function SignInScreen() {
  const theme = useTheme();
  const { t } = useStrings();
  const { sendOtp, verifyOtp, continueAsGuest, withPassword, withGoogle, withApple, isGuest } =
    useAuth();
  const { height: screenHeight } = useWindowDimensions();

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
   * A guest is not a first-time user — they have been using Baaki and have come
   * here to add a way back in — so the tour is never their problem.
   */
  const [tourSeen, setTourSeen] = useState<boolean | null>(isGuest ? true : null);

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
  const [intent, setIntent] = useState<'sign_in' | 'sign_up'>('sign_in');
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
   * rows, then a hairline, then email, guest, and a line for somebody who
   * already has an account.
   *
   * The providers moved above the fold and grew labels because a mark alone
   * does not say which account it would use, and the order they arrive in is
   * the platform's, not ours (see `SocialRow`). ADR-006 says nobody registers
   * before they can split a bill, so the guest way stays on this first screen
   * rather than behind a form; it is quieter than the email button, not hidden.
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
              {t.signIn.tagline}
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
                Apple account is one tap from being signed in, and every app
                that does this well puts that tap above the form rather than
                under it — the account buttons below are for the people those
                two do not cover, not the other way round. */}
            <View style={{ gap: theme.spacing.md }}>
              <SocialRow
                busy={busy}
                wording="continue"
                onApple={() => void run(withApple)}
                onGoogle={() => void run(withGoogle)}
                t={t}
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
                size="lg"
                fullWidth
                disabled={busy}
                icon={
                  <Ionicons name="mail-outline" size={iconSize.md} color={theme.color.onBrand} />
                }
                onPress={() => {
                  setIntent('sign_up');
                  setMode(Mode.Password);
                  setShowOptions(true);
                }}
              />
              {/* ADR-006: nobody is made to register before splitting a bill, so
                  the guest way in stays on the first screen — quieter than the
                  account buttons, never hidden. */}
              <Button
                label={t.signIn.continueGuest}
                variant="secondary"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => void run(continueAsGuest)}
              />
              {/* Coming back is a different errand from starting, and it is the
                  rarer one on this screen: a line, not a third block. */}
              <Button
                label={t.signIn.haveAccount}
                variant="ghost"
                fullWidth
                disabled={busy}
                onPress={() => {
                  setIntent('sign_in');
                  setMode(Mode.Password);
                  setShowOptions(true);
                }}
              />
            </View>

            {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
            {error ? <Callout tone="negative">{error}</Callout> : null}

            <Text
              variant="micro"
              tone="faint"
              align="center"
              style={{ paddingTop: theme.spacing.xs }}
            >
              Baaki {Constants.expoConfig?.version ?? ''}
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
                {isGuest ? t.signIn.keepOnNextPhone : t.signIn.welcomeBack}
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
                wording={isGuest ? 'continue' : 'signIn'}
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
                  {/* The way between sign-in and sign-up sits above the fields, not
                      below the submit: on Android the keyboard opens over the
                      lower half while typing, and a toggle hidden behind it is a
                      toggle that does not exist to the person looking for it. A
                      guest has no such choice — they are adding a way back to the
                      account they already have, never signing up or in. */}
                  {isGuest ? null : (
                    <Button
                      label={
                        intent === 'sign_up' ? t.signIn.switchToSignIn : t.signIn.switchToSignUp
                      }
                      variant="ghost"
                      onPress={() => {
                        setIntent(intent === 'sign_up' ? 'sign_in' : 'sign_up');
                        setError(null);
                      }}
                    />
                  )}
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

            {/* ADR-006: nobody is forced to register before they can use Baaki.
              Still here, one step back from the welcome, for somebody who came
              looking for their account and decided not to bother. */}
            {isGuest ? null : (
              <Button
                label={t.signIn.continueGuest}
                variant="ghost"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => void run(continueAsGuest)}
              />
            )}

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
 * "Sign in with" is reserved for the one screen where it is true: somebody who
 * tapped "I already have an account". Everywhere else the same button both makes
 * an account and returns to one, and both Apple's and Google's own guidelines
 * say to write "Continue with" when it does. It matters here beyond wording — a
 * guest tapping it is attaching a way back into the groups already on this
 * phone, and "sign in" would suggest they are about to land somewhere else.
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
