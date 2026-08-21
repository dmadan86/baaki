import { useEffect, useState } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, Platform, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import {
  Button,
  CurvedPanel,
  iconSize,
  setLayoutDirection,
  Text,
  ThemeProvider,
  useTheme,
} from '@waves/ui';

import { Onboarding } from '@/components/Onboarding';
import { AnimatedSplash } from '@/components/AnimatedSplash';
import { AppTabBar } from '@/components/AppTabBar';
import { CampaignPopup } from '@/components/CampaignPopup';
import { NotificationPrompt } from '@/components/NotificationPrompt';
import { TourOverlay } from '@/components/TourOverlay';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { UpdateBanner, UpdateGate } from '@/components/UpdateGate';
import { AuthProvider, useAuth } from '@/lib/auth';
import { DeviceSessionProvider } from '@/lib/deviceSession';
import { useFlagEnabled } from '@/lib/flags';
import { isRtl, isRtlLanguage, useStrings } from '@/i18n';
import { LanguageProvider, useLanguage } from '@/i18n/language';
import { LocaleSync } from '@/i18n/localeSync';
import { LockProvider, useLock } from '@/lib/lock';
import { MotionProvider, TRANSITION_MS, useMotion } from '@/lib/motion';
import { TourProvider } from '@/lib/tour';
import { PromptQueueProvider } from '@/lib/promptQueue';
import { SyncNetworkProvider } from '@/lib/syncNetwork';
import { BackupProvider } from '@/lib/cloud/BackupProvider';
import { ThemePreferenceProvider, useThemePreference } from '@/lib/theme';
import { UpdateProvider } from '@/lib/update';
import { initClarity } from '@/lib/clarity';
import { initObservability, withObservability } from '@/lib/observability';
import { ensureAndroidChannel, pushSupported, routeForNotification } from '@/lib/push';
import { applyStoredSessionReplayConsent } from '@/lib/sessionReplay';
import { SyncProvider } from '@/sync';

// Hold the native splash up past its auto-hide, so `AnimatedSplash` can take
// over the field without a blank frame between them. Native only — there is no
// native splash on web, where reaching into this is a no-op at best. It fails to
// off: a rejection here must never keep the splash up forever.
if (Platform.OS !== 'web') {
  void SplashScreen.preventAutoHideAsync().catch(() => {});
}

// Before anything else renders, so a crash in the first frame is still caught.
// Inert unless a DSN is configured.
initObservability();

// Brought up capturing nothing. Session replay would otherwise record other
// people's expense descriptions, amounts and payment handles from the first
// frame; `allowSessionReplay` is the only thing that starts it.
initClarity();

// Resume capture only for someone who opted in on a previous run; everyone
// else stays paused where `initClarity` left them. Async, and it fails to off.
void applyStoredSessionReplayConsent();

// Arriving while the app is open should still surface: a notification that is
// silently swallowed because you happened to be looking at the app is the one
// people notice missing.
if (pushSupported) {
  Notifications.setNotificationHandler({
    handleNotification: async () => ({
      shouldShowBanner: true,
      shouldShowList: true,
      shouldPlaySound: false,
      shouldSetBadge: false,
    }),
  });
}

// The device-local flag that the intro tour has been seen. Shared verbatim with
// the value AuthFlow wrote before the tour moved here, so anybody who already
// saw it pre-move is not shown it again.
const TOUR_KEY = 'baaki.onboarding_seen';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime pushes invalidations, so aggressive refetching is wasted work.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

/**
 * Tell the design system which way we run, before anything renders.
 *
 * The phone's language is the starting guess, and `LanguageProvider` corrects
 * it on mount — to the direction the app actually launched in on a device, and
 * to the chosen language on web, where the mirroring follows `dir` live.
 *
 * Taken from the language rather than `I18nManager.isRTL`, because on web that
 * flag stays false even with `dir="rtl"` on the root and a visibly mirrored
 * layout — and web is where this repo does its visual checks. An arrow that
 * keeps pointing the wrong way in a mirrored screenshot is a check that passes
 * while the screen is wrong.
 */
setLayoutDirection(isRtl());

/**
 * `dir` is what makes react-native-web mirror the layout. On a device the
 * native side has already decided at launch and this is inert — but web is how
 * this repo does its visual checks, so without it every RTL check would be
 * looking at a left-to-right screen.
 *
 * It is a react-native-web prop with no React Native counterpart, so it is not
 * in the View types. The cast lives here and nowhere else.
 *
 * Inside a component rather than at module scope now, because the language is
 * something somebody can change while the app is open.
 */
function DirectionRoot({ children }: { children: React.ReactNode }) {
  const { language } = useLanguage();
  const webDirection = { dir: isRtlLanguage(language) ? 'rtl' : 'ltr' } as object;

  return (
    <GestureHandlerRootView style={{ flex: 1 }} {...webDirection}>
      {children}
    </GestureHandlerRootView>
  );
}

function RootLayout() {
  return (
    // Outermost, above even the gesture root: every string in the app below it
    // reads from here, and the root view's own direction is one of them.
    <LanguageProvider>
      <DirectionRoot>
        <SafeAreaProvider>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              {/* Directly under the auth tree and outside every gate: which
                  language somebody is notified in should not depend on whether
                  the app is locked or the build is current. */}
              <LocaleSync />
              <SyncProvider>
                <LockProvider>
                  <MotionProvider>
                    <SyncNetworkProvider>
                      <BackupProvider>
                        <UpdateProvider>
                          <ThemePreferenceProvider>
                            <TourProvider>
                              <PromptQueueProvider>
                                <ThemedRoot>
                                  <ThemedStatusBar />
                                  {/* Outside the lock and the auth gate on purpose: a build
                            we have stopped trusting should not be unlocking a
                            ledger or signing anybody in either. */}
                                  <UpdateGate>
                                    <PushRouting />
                                    <LockGate>
                                      {/* Inside the lock so the two-device gate never
                                paints over the lock screen, and past auth so it
                                only ever asks a signed-in account. */}
                                      <DeviceSessionProvider>
                                        <AuthGate />
                                        {/* Inside the lock on purpose: a promotion is not a
                                  reason to show somebody's phone anything before
                                  they have unlocked it. */}
                                        <CampaignPopup />
                                        {/* The soft ask for push, once, to a
                                        signed-in person whose permission is
                                        still undetermined. */}
                                        <NotificationPrompt />
                                      </DeviceSessionProvider>
                                    </LockGate>
                                    {/* The coach-mark tour, over the whole app but
                                    only ever started from Home. Above the gate
                                    so its scrim covers the screen. */}
                                    <TourOverlay />
                                    {/* Last, so it paints over the screen rather than
                              under it. */}
                                    <UpdateBanner />
                                  </UpdateGate>
                                  {/* Topmost of all: the launch field, painting over
                                  the whole app until it fades itself out. Native
                                  only; renders nothing on web. */}
                                  <AnimatedSplash />
                                </ThemedRoot>
                              </PromptQueueProvider>
                            </TourProvider>
                          </ThemePreferenceProvider>
                        </UpdateProvider>
                      </BackupProvider>
                    </SyncNetworkProvider>
                  </MotionProvider>
                </LockProvider>
              </SyncProvider>
            </AuthProvider>
          </QueryClientProvider>
        </SafeAreaProvider>
      </DirectionRoot>
    </LanguageProvider>
  );
}

export default withObservability(RootLayout);

/**
 * Bridges the stored scheme preference into the design system.
 *
 * `ThemeProvider` already reads the OS scheme on its own, so a null preference
 * (follow the phone) passes `undefined` and lets it — only an explicit light or
 * dark choice forces its hand.
 */
function ThemedRoot({ children }: { children: React.ReactNode }) {
  const { preference } = useThemePreference();
  return (
    <ThemeProvider forceScheme={preference ?? undefined}>
      {/* Inside the theme so the recover screen is themed, and around the whole
          app below it so a render error on any screen lands here instead of on a
          blank root. */}
      <ErrorBoundary>{children}</ErrorBoundary>
    </ThemeProvider>
  );
}

/**
 * The status bar's icons, following the scheme actually in force — light icons
 * on the dark canvas, dark on the light. `style="auto"` reads the OS instead,
 * so an overridden theme would leave it inverted against its own background.
 */
function ThemedStatusBar() {
  const theme = useTheme();
  return <StatusBar style={theme.scheme === 'dark' ? 'light' : 'dark'} />;
}

/**
 * Sends a tapped notification where it points.
 *
 * Inside the navigation tree rather than at module scope, because a deep link
 * fired before the router exists goes nowhere and takes the tap with it.
 */
function PushRouting() {
  const router = useRouter();

  useEffect(() => {
    // expo-notifications has no web implementation, and reaching into it there
    // throws rather than no-opping — which takes the whole app down on the
    // platform this repo uses for visual checks.
    if (!pushSupported) return;

    void ensureAndroidChannel();

    // A tap that launched the app from cold arrives as the "last response"
    // rather than as an event, so both paths are needed.
    void Notifications.getLastNotificationResponseAsync()
      .then((response) => {
        const route = response ? routeForNotification(response) : null;
        if (route) router.push(route as never);
      })
      .catch(() => {});

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = routeForNotification(response);
      if (route) router.push(route as never);
    });
    return () => subscription.remove();
  }, [router]);

  return null;
}

/**
 * Holds the whole app behind biometrics when the user has asked for it.
 *
 * Deliberately the same shape as the welcome — coloured sweep, wordmark, one
 * button, version at the foot. Somebody meeting this screen is looking at a
 * phone that will not open, and the fastest way to say "this is still your app,
 * nothing has gone wrong" is for it to look like the app.
 */
function LockGate({ children }: { children: React.ReactNode }) {
  const { locked, unlock } = useLock();
  const theme = useTheme();
  const { t } = useStrings();
  const { height: screenHeight } = useWindowDimensions();

  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);

  if (!locked) return <>{children}</>;

  return (
    <View style={{ flex: 1, backgroundColor: theme.color.bg }}>
      <CurvedPanel height={Math.min(screenHeight * 0.46, 420)}>
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            gap: theme.spacing.sm,
          }}
        >
          <Text
            style={{ fontSize: 56, lineHeight: 72, fontWeight: '700', color: theme.color.onBrand }}
          >
            {t.common.appName}
          </Text>
          <Ionicons name="lock-closed" size={iconSize.xl} color={theme.color.onBrand} />
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
          {t.extras.lockedTitle}
        </Text>
        <Text variant="body" tone="muted" align="center">
          {t.extras.lockedBody}
        </Text>
        <View style={{ paddingTop: theme.spacing.md }}>
          <Button label={t.extras.unlock} size="lg" fullWidth onPress={() => void unlock()} />
        </View>
      </View>

      <Text
        variant="micro"
        tone="faint"
        align="center"
        style={{ paddingBottom: theme.spacing.xxxl }}
      >
        {t.common.appName} {Constants.expoConfig?.version ?? ''}
      </Text>
    </View>
  );
}

/** Sends signed-out users to the sign-in screen, and back once they are in. */
function AuthGate() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const theme = useTheme();
  const { animated } = useMotion();
  // The paywall is an unwired placeholder (no store products, no purchase
  // handling), so its route is registered only where a flag turns it on —
  // otherwise a deep link cannot reach a screen that would only mislead.
  const paywallEnabled = useFlagEnabled('paywall');

  /**
   * Pushes cut straight to the destination — no slide. The slide-from-right was
   * the most visible transition and the one that read as slow, so a push now
   * lands instantly; "back" is still carried by the header and the swipe gesture.
   * A modal still rises from the bottom, because that rise is what says "on top
   * of" rather than "gone to", and it is cheap; with motion off it too is `none`.
   */
  const push = 'none' as const;
  const sheet = animated ? ('slide_from_bottom' as const) : ('none' as const);
  const modal = { presentation: 'modal' as const, animation: sheet };

  // The two auth doors and the invite-accept screen are the only routes a
  // signed-out person is allowed to sit on. `onAuth` covers both doors so a
  // session that appears bounces off either one back into the app.
  const onSignIn = segments[0] === 'sign-in';
  // The welcome gateway is where a signed-out person lands; a session appearing
  // on it (or on either door) bounces back into the app, so it counts as auth.
  // The guest doorway counts as auth too: a signed-out person is allowed to sit
  // on it, and the moment its Continue mints a guest session the gate bounces it
  // into the app, exactly like the doors.
  // `phone` counts as auth for the same reason the doors do: a nobody signs in
  // there (or, in a dev build, the 000000 stub mints a guest), and the moment
  // that session appears the gate must bounce it into the app — otherwise it
  // sits on the code screen with a live session and nowhere to go.
  // `verify-email` joins them: the email code is entered there, and the session
  // `verifyOtp` mints must bounce into the app just like the phone code does.
  const onAuth =
    onSignIn ||
    segments[0] === 'sign-up' ||
    segments[0] === 'welcome' ||
    segments[0] === 'guest-welcome' ||
    segments[0] === 'phone' ||
    segments[0] === 'verify-email';
  // The privacy screen is reachable signed-out too, so the Terms & Privacy line
  // on the welcome and guest doorways can open it before anybody has an account.
  const onPublicRoute =
    onAuth ||
    segments[0] === 'join' ||
    segments[0] === 'language' ||
    (segments[0] === 'settings' && (segments as string[])[1] === 'privacy');

  /**
   * The route we are on disagrees with the session we have, and the effect
   * below is about to `replace` to the right one. The Stack's default route is
   * `(tabs)` — the dashboard — so rendering it now, for the frame before the
   * redirect lands, is exactly the flash of the dashboard a signed-out person
   * sees on a cold start. Hold the spinner until the route and the session
   * agree, and the app tree never mounts the wrong screen at all.
   */
  const needsRedirect = !loading && ((!session && !onPublicRoute) || (Boolean(session) && onAuth));

  useEffect(() => {
    if (loading) return;
    if (!session && !onPublicRoute) router.replace('/welcome');
    else if (session && onAuth) router.replace('/');
  }, [session, loading, onAuth, onPublicRoute, router]);

  // The intro tour now comes *after* sign-in, not in front of it: the first
  // authenticated launch on this device shows the three cards once, over the
  // app, then never again. `null` until storage answers, so it neither flashes
  // for a returning account nor holds a first-timer at a blank screen.
  const [tourSeen, setTourSeen] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void AsyncStorage.getItem(TOUR_KEY)
      .then((value) => {
        if (!cancelled) setTourSeen(value === 'yes');
      })
      // Storage failing is not a reason to trap somebody on the tour forever;
      // worst case they miss it, which costs nothing they cannot find later.
      .catch(() => {
        if (!cancelled) setTourSeen(true);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (loading || needsRedirect) {
    return (
      <View
        style={{
          flex: 1,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: theme.color.bg,
        }}
      >
        <ActivityIndicator color={theme.color.brand} />
      </View>
    );
  }

  // A signed-in person who has not seen the tour meets it here, once, before
  // the app proper. Held while storage is still answering so the app tree does
  // not paint under it for a frame.
  if (session && tourSeen !== true) {
    if (tourSeen === null) {
      return (
        <View
          style={{
            flex: 1,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.color.bg,
          }}
        >
          <ActivityIndicator color={theme.color.brand} />
        </View>
      );
    }
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

  return (
    <View style={{ flex: 1 }}>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: 'transparent' },
          animation: push,
          animationDuration: TRANSITION_MS,
          // Swiping back is the same journey as the animation, so it belongs to
          // the same switch: with motion off there is nothing to drag.
          gestureEnabled: animated,
        }}
      >
        {/* Signing in and out replaces the whole tree; sliding it would suggest a
          place to go back to, and there is not one. */}
        <Stack.Screen name="welcome" options={{ animation: 'none' }} />
        <Stack.Screen name="language" />
        <Stack.Screen name="sign-in" options={{ animation: 'none' }} />
        {/* The sign-up page slides in from the login screen and back out, so it
            keeps a normal push — unlike sign-in, which replaces the whole tree. */}
        <Stack.Screen name="sign-up" />
        <Stack.Screen name="phone" />
        <Stack.Screen name="verify-email" />
        <Stack.Screen name="guest-welcome" />
        <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
        <Stack.Screen name="new-group" options={modal} />
        {paywallEnabled ? <Stack.Screen name="paywall" options={modal} /> : null}
        <Stack.Screen name="capture" options={modal} />
        <Stack.Screen name="captures" />
        <Stack.Screen name="group/[id]/index" />
        <Stack.Screen name="group/[id]/add-expense" options={modal} />
        <Stack.Screen name="group/[id]/settle" options={modal} />
        <Stack.Screen name="group/[id]/simplify" />
        <Stack.Screen name="group/[id]/settings" />
        <Stack.Screen name="group/[id]/members" />
        <Stack.Screen name="group/[id]/member/[memberId]" />
        <Stack.Screen name="group/[id]/expense/[expenseId]" />
        <Stack.Screen name="group/[id]/invite" options={modal} />
        <Stack.Screen name="group/[id]/itemize" options={modal} />
        <Stack.Screen name="receipt/[id]" options={modal} />
        <Stack.Screen name="friends/contacts" />
        <Stack.Screen name="settings/backup" />
        <Stack.Screen name="settings/notifications" />
        <Stack.Screen name="settings/export" />
        <Stack.Screen name="settings/import" />
        <Stack.Screen name="settings/lock" />
        <Stack.Screen name="settings/devices" />
        <Stack.Screen name="settings/motion" />
        <Stack.Screen name="settings/sync" />
        <Stack.Screen name="settings/theme" />
        <Stack.Screen name="settings/language" />
        <Stack.Screen name="settings/upgrade" />
        <Stack.Screen name="settings/redeem" />
        <Stack.Screen name="settings/account" />
        <Stack.Screen name="settings/feedback" />
        <Stack.Screen name="settings/privacy" />
        <Stack.Screen name="settings/delete-account" />
        <Stack.Screen name="join" />
        <Stack.Screen name="inbox" />
        <Stack.Screen name="voice" options={modal} />
      </Stack>
      {/* One bar over the whole stack, so every screen keeps it — it hides
          itself on the modals and the camera. */}
      <AppTabBar />
    </View>
  );
}
