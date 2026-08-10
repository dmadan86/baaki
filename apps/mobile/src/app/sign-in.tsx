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

import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
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

import {
  Button,
  Callout,
  Card,
  CurvedPanel,
  Screen,
  SegmentedTabs,
  Text,
  useTheme,
} from '@baaki/ui';

import { AppleSignInButton } from '@/components/AppleSignInButton';
import { LanguagePicker } from '@/components/LanguagePicker';
import { Onboarding } from '@/components/Onboarding';
import { useStrings } from '@/i18n';
import { useAuth } from '@/lib/auth';

type Mode = 'otp' | 'password';

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
              {t.signIn.tagline}
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
            {t.signIn.splitAnything}
          </Text>
          <Text variant="body" tone="muted" align="center">
            {`${t.freeForever}. ${t.signIn.welcomeBody}`}
          </Text>

          <View style={{ gap: theme.spacing.sm, paddingTop: theme.spacing.md }}>
            <Button
              label={t.signIn.startNow}
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void run(continueAsGuest)}
            />
            <Button
              label={t.signIn.haveAccount}
              variant="ghost"
              fullWidth
              onPress={() => setShowOptions(true)}
            />
          </View>

          {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
          {error ? <Callout tone="negative">{error}</Callout> : null}
        </View>

        {/* Under the buttons, not above them. The decision this screen exists
            to get is "start now"; the language is the one thing somebody might
            have to fix before they can read it, which earns a place on the
            screen but not the top of it. */}
        <View
          style={{
            paddingHorizontal: theme.spacing.xl,
            paddingBottom: theme.spacing.xxxl,
            gap: theme.spacing.md,
          }}
        >
          <LanguagePicker />
          <Text variant="micro" tone="faint" align="center">
            Baaki {Constants.expoConfig?.version ?? ''}
          </Text>
        </View>
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
                  { value: 'otp', label: t.signIn.sendMeACode },
                  { value: 'password', label: t.signIn.useAPassword },
                ]}
              />

              {mode === 'otp' && stage === 'phone' ? (
                <>
                  <Text variant="caption" tone="muted">
                    {t.signIn.phoneNumber}
                  </Text>
                  <TextInput
                    value={phone}
                    onChangeText={setPhone}
                    keyboardType="phone-pad"
                    autoComplete="tel"
                    accessibilityLabel={t.signIn.phoneNumber}
                    placeholderTextColor={theme.color.textFaint}
                    style={{
                      fontSize: 22,
                      fontWeight: '600',
                      color: theme.color.text,
                      paddingVertical: theme.spacing.sm,
                    }}
                  />
                  <Text variant="micro" tone="faint">
                    {t.signIn.countryCodeHint}
                  </Text>
                  <Button
                    label={t.signIn.sendCode}
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
                    {t.signIn.codeSentTo.replace('{value}', phone)}
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
                    onPress={() => void run(() => verifyOtp(phone.trim(), code.trim()))}
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

              {mode === 'password' ? (
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
                    placeholder={t.signIn.identifierPlaceholder}
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
                  <Text variant="micro" tone="faint">
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
                  {/* A guest is never signing up or in — they are adding a way
                    back to the account they already have. */}
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
                </>
              ) : null}

              {busy ? <ActivityIndicator color={theme.color.brand} /> : null}
              {error ? <Callout tone="negative">{error}</Callout> : null}
            </Card>

            <Button
              label={isGuest ? t.signIn.continueGoogle : t.signIn.signInGoogle}
              variant="secondary"
              size="lg"
              fullWidth
              disabled={busy}
              onPress={() => void run(withGoogle)}
            />

            <AppleSignInButton
              label={isGuest ? t.signIn.continueApple : t.signIn.signInApple}
              disabled={busy}
              onPress={() => void run(withApple)}
            />

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

            <Text variant="micro" tone="faint" align="center">
              {isGuest ? t.signIn.guestFootnote : t.signIn.memberFootnote}
            </Text>
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
