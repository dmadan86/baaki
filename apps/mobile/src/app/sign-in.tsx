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
 *
 * The language chips are here for the same reason the guest button is: this is
 * the first screen, and the first screen has to work for somebody it opened
 * wrong. Baaki follows the phone by default, and a phone is one setting for one
 * person — a shared handset, a borrowed one, or simply a person who reads Tamil
 * and set their phone up in English. Making them sign in first, to reach a
 * settings row they cannot read, is a door that only opens from the inside.
 */

import { useEffect, useState, type ReactNode } from 'react';
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
import { deviceCountry, useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

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
   * and the three ways in — sign in, sign up, or carry on as a guest — with the
   * social marks under them. ADR-006 says nobody registers before they can split
   * a bill, so the guest way stays on this first screen rather than behind a
   * form; it is only quieter than the two account buttons, not hidden.
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
            <View style={{ gap: theme.spacing.sm }}>
              <Button
                label={t.signIn.signInAction}
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => {
                  setIntent('sign_in');
                  setMode(Mode.Password);
                  setShowOptions(true);
                }}
              />
              <Button
                label={t.signIn.createAccount}
                variant="secondary"
                size="lg"
                fullWidth
                disabled={busy}
                onPress={() => {
                  setIntent('sign_up');
                  setMode(Mode.Password);
                  setShowOptions(true);
                }}
              />
              {/* ADR-006: nobody is made to register before splitting a bill, so
                  the guest way in stays on the first screen — quieter than the
                  two account buttons, never hidden. */}
              <Button
                label={t.signIn.continueGuest}
                variant="ghost"
                fullWidth
                disabled={busy}
                onPress={() => void run(continueAsGuest)}
              />
            </View>

            {/* A hairline either side of the label, not bare text — the seam
                between "have an account" above and "one tap" below. */}
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.md }}>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
              <Text variant="caption" tone="muted">
                {t.signIn.orSignInWith}
              </Text>
              <View style={{ flex: 1, height: 1, backgroundColor: theme.color.border }} />
            </View>

            {/* The social marks up front, one tap in without a form — the same
                providers the options screen offers. */}
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'center',
                gap: theme.spacing.xl,
              }}
            >
              <ProviderTile
                label={t.signIn.signInApple}
                disabled={busy}
                onPress={() => void run(withApple)}
              >
                <Ionicons name="logo-apple" size={iconSize.xxxl} color={theme.color.text} />
              </ProviderTile>
              <ProviderTile
                label={t.signIn.signInGoogle}
                disabled={busy}
                onPress={() => void run(withGoogle)}
              >
                <Ionicons name="logo-google" size={iconSize.xxxl} color={theme.color.text} />
              </ProviderTile>
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
                  <TextInput
                    value={password}
                    onChangeText={setPassword}
                    secureTextEntry
                    autoCapitalize="none"
                    autoComplete={intent === 'sign_up' ? 'new-password' : 'current-password'}
                    accessibilityLabel={t.signIn.password}
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 18,
                      fontWeight: '500',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
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

            {/* Icon-only tiles rather than two stacked full-width buttons: the
                provider is a small choice next to the account above, and a row
                of marks reads as "one of these" in a glance where a stack of
                labelled bars reads as two more things to do.

                Apple's mark is a custom tile here, not its native button. The
                native sheet is still what opens — `withApple` calls it directly
                (see auth.tsx), the widget was only ever the surface — so on an
                iPhone this tile brings up the same system sign-in. */}
            <View style={{ gap: theme.spacing.md }}>
              <Text variant="caption" tone="muted" align="center">
                {t.signIn.orSignInWith}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  justifyContent: 'center',
                  gap: theme.spacing.lg,
                }}
              >
                <ProviderTile
                  label={isGuest ? t.signIn.continueApple : t.signIn.signInApple}
                  disabled={busy}
                  onPress={() => void run(withApple)}
                >
                  <Ionicons name="logo-apple" size={iconSize.xxxl} color={theme.color.text} />
                </ProviderTile>
                <ProviderTile
                  label={isGuest ? t.signIn.continueGoogle : t.signIn.signInGoogle}
                  disabled={busy}
                  onPress={() => void run(withGoogle)}
                >
                  <Ionicons name="logo-google" size={iconSize.xxxl} color={theme.color.text} />
                </ProviderTile>
              </View>
            </View>

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
 * A square, icon-only social button — one mark in the row under "or sign in
 * with". Icon-only, so it carries the provider's name as its accessibility
 * label; a screen reader hears "Sign in with Google", not "button".
 */
function ProviderTile({
  label,
  disabled,
  onPress,
  children,
}: {
  label: string;
  disabled?: boolean;
  onPress: () => void;
  children: ReactNode;
}) {
  const theme = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        width: 96,
        height: 60,
        borderRadius: theme.radius.lg,
        borderWidth: 1,
        borderColor: theme.color.border,
        backgroundColor: theme.color.surface,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.5 : 1,
        transform: [{ scale: pressed ? 0.97 : 1 }],
        ...theme.shadow.soft,
      })}
    >
      {children}
    </Pressable>
  );
}
