// Backfills Intl.RelativeTimeFormat (absent on Android Hermes) before anything
// renders, so relative time works app-wide. Side-effect import, must be first.
import '@/lib/intlPolyfill';

import { useEffect, useState } from 'react';
import Ionicons from '@expo/vector-icons/Ionicons';
import Constants from 'expo-constants';
import * as Notifications from 'expo-notifications';
import * as SplashScreen from 'expo-splash-screen';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import {
  ActivityIndicator,
  I18nManager,
  Platform,
  Text as RNText,
  useWindowDimensions,
  View,
} from 'react-native';
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
import { LanguageRestartPrompt } from '@/components/LanguageRestartPrompt';
import { TransferProgressBar } from '@/components/TransferProgressBar';
import { CampaignPopup } from '@/components/CampaignPopup';
import { NotificationPrompt } from '@/components/NotificationPrompt';
import { TourOverlay } from '@/components/TourOverlay';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { StatusBanner, UpdateGate } from '@/components/AppStatus';
import { AuthProvider, useAuth } from '@/lib/auth';
import { AutoBackup } from '@/lib/backup/AutoBackup';
import { backendConfigured } from '@/lib/backend';
import { CaptureNudge } from '@/lib/captureNudge/CaptureNudge';
import { SmsAutoRead } from '@/lib/smsAutoRead';
import { DeviceSessionProvider } from '@/lib/deviceSession';
import { useFlagEnabled } from '@/lib/flags';
import { isRtl, isRtlLanguage, useStrings } from '@/i18n';
import { LanguageProvider, useLanguage } from '@/i18n/language';
import { LocaleSync } from '@/i18n/localeSync';
import { LockProvider, useLock } from '@/lib/lock';
import { useRouter } from '@/lib/navigation';
import { onboardingSeen, rememberOnboardingSeen } from '@/lib/onboardingSeen';
import { isRouteAllowed } from '@/lib/routeAccess';
import { ReducedMotionProvider, useReducedMotion } from '@/lib/reducedMotion';
import { RecentCountProvider } from '@/lib/recentCount';
import { WatchBridgeProvider } from '@/lib/watch/bridge';
import { QuickShortcutRouting, QuickShortcutsMenu } from '@/components/QuickShortcuts';
import { TourProvider, useTour } from '@/lib/tour';
import { PromptQueueProvider } from '@/lib/promptQueue';
import { SyncNetworkProvider } from '@/lib/syncNetwork';
import { ThemePreferenceProvider, useThemePreference } from '@/lib/theme';
import { DialogProvider } from '@/lib/dialog';
import { ToastProvider } from '@/lib/toast';
import { AppStatusProvider } from '@/lib/appStatus';
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

// How long a forward push runs. A touch longer than a plain slide because the
// iOS-style transition has two layers to read — the incoming page arriving and
// the outgoing one parallaxing behind it — and at 260ms the second layer barely
// registers. Nav only; the shared `TRANSITION_MS` drives in-screen entrances,
// which want to stay snappier.
const NAV_TRANSITION_MS = 320;

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

/**
 * The screen a misconfigured build shows instead of crashing.
 *
 * Deliberately self-contained — plain `react-native`, no theme, no i18n, no
 * providers — because the reason it renders is that the app's foundations are
 * not set up (see `backendConfigured`). Its copy is in English because there is
 * no working string table to translate it, and the only audience is whoever
 * installed a build whose keys were never baked in.
 */
function MisconfiguredBuild() {
  return (
    <View
      style={{
        flex: 1,
        backgroundColor: '#0e1211',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 32,
      }}
    >
      <RNText style={{ color: '#e7ece9', fontSize: 20, fontWeight: '700', marginBottom: 10 }}>
        This build isn’t configured
      </RNText>
      <RNText style={{ color: '#9aa4a0', fontSize: 15, lineHeight: 22, textAlign: 'center' }}>
        Waves is missing the keys it needs to reach its servers. Please reinstall the app from the
        store, or contact support if this keeps happening.
      </RNText>
    </View>
  );
}

function RootLayout() {
  // A build shipped without its Supabase keys can do nothing useful, and must
  // not mount the auth/sync tree below — that tree would poke an unreachable
  // client. Show a plain notice instead of the crash the module-load throw used
  // to cause (see backend.ts).
  if (!backendConfigured) return <MisconfiguredBuild />;
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
                  <SyncNetworkProvider>
                    <AppStatusProvider>
                      <ThemePreferenceProvider>
                        <ReducedMotionProvider>
                          <TourProvider>
                            <PromptQueueProvider>
                              <RecentCountProvider>
                                <ThemedRoot>
                                  {/* Wraps the whole app because that is what a
                                      confirmation for something that *finishes* a
                                      screen needs: it has to still be there once
                                      that screen has gone. The children are the
                                      same element across its own state changes,
                                      so showing one does not re-render the app. */}
                                  <ToastProvider>
                                    {/* Beside the toast host and for the same
                                        reason: a question can outlive the screen
                                        that asked it, and the surface that draws
                                        it has to sit above the navigation stack.
                                        Inside the toast provider so a dialog's
                                        outcome can raise one. */}
                                    <DialogProvider>
                                      <ThemedStatusBar />
                                      {/* Renders nothing: it draws the "open the app
                                        again to mirror it" question that
                                        `LanguageProvider` can only raise as a
                                        value, being above every surface. */}
                                      <LanguageRestartPrompt />
                                      {/* Renders nothing: it keeps the app-icon long-press
                                      menu in step with the session. Outside every
                                      gate because the menu lives on the home screen,
                                      not in the app — it has to be cleared when
                                      somebody signs out, and an upgrade has to replace
                                      the single shortcut the old version published,
                                      whether or not this launch gets past the lock. */}
                                      <QuickShortcutsMenu />
                                      {/* Outside the lock and the auth gate on purpose: a build
                            we have stopped trusting should not be unlocking a
                            ledger or signing anybody in either. */}
                                      <UpdateGate>
                                        <PushRouting />
                                        <LockGate>
                                          {/* Below the lock and update gates so the watch
                                bridge never turns a wrist tap into a capture
                                while the app is locked or on a build we have
                                stopped trusting. */}
                                          <WatchBridgeProvider />
                                          {/* Same reasoning, one step further: an
                                automatic backup must not run on a build we
                                have stopped trusting, and must not decrypt a
                                ledger while the app is still locked. */}
                                          <AutoBackup />
                                          {/* Renders nothing: it decides whether this phone
                                should remind anybody about the expenses they
                                saved for later, and sets or cancels the local
                                alarm that does it. Beside the backup and inside
                                the same gates — the count it speaks about is
                                read from the mirror, which must not be touched
                                while the app is still locked. */}
                                          <CaptureNudge />
                                          {/* Renders nothing: it reads the bank
                                messages this phone is allowed to read, on a
                                permission somebody already granted, and keeps
                                the hourly background check in step with the
                                gates. Beside the nudge and inside the same ones
                                — a build we have stopped trusting should not be
                                reading anybody's inbox, and nothing should touch
                                the mirror while the app is still locked. */}
                                          <SmsAutoRead />
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
                                        <StatusBanner />
                                      </UpdateGate>
                                      {/* Topmost of all: the launch field, painting over
                                  the whole app until it fades itself out. Native
                                  only; renders nothing on web. */}
                                      <AnimatedSplash />
                                    </DialogProvider>
                                  </ToastProvider>
                                </ThemedRoot>
                              </RecentCountProvider>
                            </PromptQueueProvider>
                          </TourProvider>
                        </ReducedMotionProvider>
                      </ThemePreferenceProvider>
                    </AppStatusProvider>
                  </SyncNetworkProvider>
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

/**
 * Sends signed-out users to the welcome screen, and back once they are in.
 *
 * Two mechanisms, deliberately: the `Stack.Protected` groups in the tree below
 * are what make the doors *unreachable* — they take the history with them when
 * the session flips — while the effect here is the redirect for routes that are
 * not listed on the stack at all (expo-router auto-includes every file), so a
 * deep link to one of those cannot park a signed-out person inside the app.
 */
function AuthGate() {
  const { session, loading } = useAuth();
  const segments = useSegments();
  const router = useRouter();
  const theme = useTheme();
  const reduceMotion = useReducedMotion();
  // Finishing the 3-card intro also marks the coach tour seen, so a new person
  // is not toured twice back-to-back (the intro, then the coach-marks). The
  // coach tour stays available on demand from the Home overflow menu.
  const tour = useTour();
  // The paywall is an unwired placeholder (no store products, no purchase
  // handling), so its route is registered only where a flag turns it on —
  // otherwise a deep link cannot reach a screen that would only mislead.
  const paywallEnabled = useFlagEnabled('paywall');

  // Every forward screen slides in from the leading edge — one consistent
  // motion across the whole app (right in LTR, left in RTL). The only screens
  // that opt out are the auth and tab roots below, which replace the whole tree
  // and mark themselves `animation: 'none'`. Screens that once rose as bottom
  // modals now slide too, so navigation reads the same everywhere.
  //
  // The iOS-style variant, not the plain slide: the incoming page comes in from
  // the leading edge over the *outgoing* one, which parallaxes a shorter way the
  // other direction under a hairline shadow rather than travelling the full width
  // in lockstep. That is the two-layers-moving-at-different-rates feel of the
  // WhatsApp push the design is matched to — the old screen holding behind while
  // the new one arrives — and it stays on the UI thread, so it costs nothing over
  // the bare slide. The edge still follows the writing direction (Arabic pushes
  // from the left), so it never slides the wrong way.
  const push = reduceMotion
    ? ('none' as const)
    : I18nManager.isRTL
      ? ('ios_from_left' as const)
      : ('ios_from_right' as const);
  // A normal forward page: a plain horizontal translate (and back out the way it
  // came) rather than rising like a modal — the "went to a page", not "on top of"
  // feel. A bare translate is the cheapest native transition on the UI thread, so
  // it stays smooth where the platform 'default' (which drags an elevation/shadow
  // across) can stutter in a dev build. The edge follows the writing direction —
  // from the right in LTR, from the left in RTL (Arabic) — so it never slides the
  // wrong way.
  const slide = {
    animation: push,
  };

  // Which routes go with which session — the same lists the `Stack.Protected`
  // groups below are built from, kept in `lib/routeAccess` so the guard and this
  // redirect cannot drift apart.
  const signedIn = Boolean(session);
  const routeAllowed = isRouteAllowed(segments as string[], signedIn, __DEV__, {
    paywall: paywallEnabled,
  });

  /**
   * The route we are on disagrees with the session we have, and the effect
   * below is about to `replace` to the right one. The Stack's default route is
   * `(tabs)` — the dashboard — so rendering it now, for the frame before the
   * redirect lands, is exactly the flash of the dashboard a signed-out person
   * sees on a cold start. Hold the spinner until the route and the session
   * agree, and the app tree never mounts the wrong screen at all.
   */
  const needsRedirect = !loading && !routeAllowed;

  useEffect(() => {
    if (loading || routeAllowed) return;
    if (!session) router.replace('/welcome');
    else router.replace('/');
  }, [session, loading, routeAllowed, router]);

  // The intro tour comes *after* sign-in, not in front of it: the first launch
  // of an account shows the three cards once, over the app, then never again.
  // Asked per account rather than per phone — the flag used to be one
  // device-wide key, so the first person to finish the tour on a handset
  // silently cancelled it for every account that signed in there afterwards
  // (see `lib/onboardingSeen`).
  //
  // The answer is stored *with the account it is about*, the way the profile is,
  // rather than as a bare boolean that a change of account has to reset: an
  // answer left behind by whoever was signed in before must not decide this
  // person's tour, and clearing it from the effect body is a cascading render.
  // So `tourSeen` is derived — `null` until storage has answered for the current
  // account, which neither flashes the tour at a returning one nor holds a
  // first-timer at a blank screen.
  const ownerId = session?.user.id ?? null;
  const [tourAnswer, setTourAnswer] = useState<{ owner: string; seen: boolean } | null>(null);
  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    // Never rejects — a phone whose storage refuses to answer reports "seen"
    // rather than trapping somebody behind an intro they cannot dismiss.
    void onboardingSeen(ownerId).then((seen) => {
      if (!cancelled) setTourAnswer({ owner: ownerId, seen });
    });
    return () => {
      cancelled = true;
    };
  }, [ownerId]);
  const tourSeen = tourAnswer && tourAnswer.owner === ownerId ? tourAnswer.seen : null;

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
  if (session && ownerId && tourSeen !== true) {
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
          setTourAnswer({ owner: ownerId, seen: true });
          // Not awaited: the tour is over the moment they say so, and a write
          // that fails costs them one repeat, not a stuck screen.
          void rememberOnboardingSeen(ownerId);
          // One onboarding, not two: mark the coach tour seen as well so it does
          // not autostart on the Home screen the intro just handed them to.
          tour.finish();
        }}
      />
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* Renders nothing: it routes a tap on one of the menu's three entries.
          Here rather than higher up so a shortcut is never acted on while the
          app is locked or the intro is still running — there is nowhere to send
          somebody yet. The menu itself is published above every gate. */}
      <QuickShortcutRouting />
      <Stack
        screenOptions={{
          headerShown: false,
          // Paint the app background on the sliding card. A transparent card
          // lets the bare window (white) show through mid-transition, which
          // read as a white flash while a screen slid in. The heroes still
          // paint their own gradient over this, so nothing else changes.
          contentStyle: { backgroundColor: theme.color.bg },
          animation: push,
          animationDuration: reduceMotion ? 0 : NAV_TRANSITION_MS,
          gestureEnabled: true,
        }}
      >
        {/* The doors, and only the doors.
              `Stack.Protected` is not decoration here: when a guard flips from
              true to false, expo-router *removes every history entry* for the
              screens inside it. That is the whole fix for "sign in, land on the
              dashboard, press Android back, and the login screen comes back" —
              a `replace` only swaps the top of the stack, so `welcome` (and
              anything pushed from it) stayed underneath as a back target. With
              the group guarded, a session appearing erases those entries and
              back from the dashboard leaves the app, which is what every other
              app on the phone does.
              It cuts the other way too: signing out drops the whole signed-in
              history, so back cannot walk into a screen the account no longer
              owns.
              This group must stay FIRST — a signed-out person on a guarded app
              screen falls back to the first screen still available, and that
              should be `welcome`. */}
        <Stack.Protected guard={!session}>
          {/* Signing in and out replaces the whole tree; sliding it would suggest a
            place to go back to, and there is not one. */}
          <Stack.Screen name="welcome" options={{ animation: 'none' }} />
          <Stack.Screen name="sign-in" options={{ animation: 'none' }} />
          {/* The sign-up page slides in from the login screen and back out, so it
              keeps a normal push — unlike sign-in, which replaces the whole tree. */}
          <Stack.Screen name="sign-up" />
          <Stack.Screen name="phone" />
          <Stack.Screen name="verify-email" />
          <Stack.Screen name="guest-welcome" />
        </Stack.Protected>
        {/* Everything behind the door. Guarded for the mirror-image reason:
              signing out erases this history, so back cannot re-enter a screen
              belonging to the account that just left. */}
        <Stack.Protected guard={Boolean(session)}>
          <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
          {/* Settings. A screen on this stack, not a fifth member of the tab
              group it used to live in: it is reached by a push (the header
              avatar, the overflow menu), never by the bottom bar, and inside
              the tab navigator it inherited that navigator's instant switch —
              so it appeared in one frame while every other pushed screen slid.
              Here it pushes like the rest, and back pops back to where it was
              opened from. */}
          <Stack.Screen name="profile" options={slide} />
          <Stack.Screen name="new-group" options={slide} />
          <Stack.Screen name="clone-group" options={slide} />
          {/* The paywall is an unwired placeholder, so it stays unreachable
                until its flag is on — a nested guard rather than a conditional,
                because a `null` child is not a screen and the navigator warns
                about one. */}
          <Stack.Protected guard={paywallEnabled}>
            <Stack.Screen name="paywall" options={slide} />
          </Stack.Protected>
          <Stack.Screen name="capture" options={slide} />
          {/* The Review tab lives at `(tabs)/captures.tsx` and resolves at
              `/captures`; these two are pushed on top of it, so a `captures/`
              folder beside the tab group is exactly right and collides with
              nothing. */}
          <Stack.Screen name="captures/paste" options={slide} />
          <Stack.Screen name="captures/messages" options={slide} />
          {/* Activity, out of the tab group and onto this stack — the mirror
              image of the move `captures` made the other way (see
              `(tabs)/_layout.tsx`). It is reached from the dashboard hero now,
              not the bar, so it pushes and slides like `profile` and `groups`
              rather than cutting instantly the way a tab switch does. */}
          <Stack.Screen name="activity" options={slide} />
          <Stack.Screen name="groups" options={slide} />
          <Stack.Screen name="group/[id]/index" options={slide} />
          <Stack.Screen name="group/[id]/add-expense" options={slide} />
          <Stack.Screen name="group/[id]/settle" options={slide} />
          <Stack.Screen name="group/[id]/simplify" />
          <Stack.Screen name="group/[id]/settings" />
          <Stack.Screen name="group/[id]/members" />
          <Stack.Screen name="group/[id]/member/[memberId]" />
          <Stack.Screen name="group/[id]/expense/[expenseId]" options={slide} />
          <Stack.Screen name="group/[id]/invite" options={slide} />
          <Stack.Screen name="group/[id]/itemize" options={slide} />
          <Stack.Screen name="group/[id]/export" options={slide} />
          <Stack.Screen name="group/[id]/insights" />
          <Stack.Screen name="group/[id]/map" />
          <Stack.Screen name="group/[id]/month" />
          <Stack.Screen name="group/[id]/pending" />
          <Stack.Screen name="group/[id]/plan" />
          <Stack.Screen name="group/[id]/recap" />
          <Stack.Screen name="receipt/[id]" options={slide} />
          <Stack.Screen name="friends/add-person" />
          <Stack.Screen name="friends/contacts" />
          <Stack.Screen name="friends/merge" />
          <Stack.Screen name="friends/person/[key]" />
          <Stack.Screen name="contact-picker" options={slide} />
          <Stack.Screen name="country" options={slide} />
          <Stack.Screen name="scan" options={slide} />
          <Stack.Screen name="personal/transactions" />
          <Stack.Screen name="personal/entry" options={slide} />
          <Stack.Screen name="personal/recurring" />
          <Stack.Screen name="personal/loans" />
          <Stack.Screen name="personal/budgets" />
          <Stack.Screen name="personal/source/[id]" />
          <Stack.Screen name="settings/notifications" />
          <Stack.Screen name="settings/export" />
          <Stack.Screen name="settings/import" />
          <Stack.Screen name="settings/lock" />
          <Stack.Screen name="settings/devices" />
          <Stack.Screen name="settings/offline-voice" />
          <Stack.Screen name="settings/recent" />
          <Stack.Screen name="settings/sync" />
          <Stack.Screen name="settings/backup" />
          <Stack.Screen name="settings/archived" />
          <Stack.Screen name="settings/blocked" />
          <Stack.Screen name="settings/storage" />
          <Stack.Screen name="settings/theme" />
          <Stack.Screen name="settings/categories" />
          <Stack.Screen name="settings/language" />
          <Stack.Screen name="settings/packs" />
          <Stack.Screen name="settings/packs/[slug]" />
          <Stack.Screen name="settings/paying" />
          <Stack.Screen name="settings/upgrade" />
          <Stack.Screen name="settings/redeem" />
          <Stack.Screen name="settings/account" />
          <Stack.Screen name="settings/feedback" />
          <Stack.Screen name="settings/delete-account" />
          {/* The drafts inbox is a tab-navigator destination now (see
              `(tabs)/captures.tsx`), so it is no longer a screen on this root
              stack — a tap on it from anywhere is an instant tab swap rather
              than a push that re-reveals and thaws the whole tab tree. */}
          <Stack.Screen name="voice" options={slide} />
        </Stack.Protected>
        {/* Reachable with or without a session, so they belong to neither
              group: the language picker is offered on the welcome screen, and
              `join`/`settings/privacy` are opened from links and policy lines
              that may arrive before anybody has an account. They sit last on
              purpose — a guard flipping falls back to the first screen still
              available, and that should be `welcome` signed out and the tabs
              signed in, never the language picker. */}
        <Stack.Screen name="language" />
        <Stack.Screen name="join" />
        <Stack.Screen name="settings/privacy" />
        <Stack.Screen name="settings/licenses" />
        {/* Dev-only screen, and deliberately still reachable after sign-out so
              the e2e suite can prove private local state was removed. */}
        <Stack.Protected guard={__DEV__}>
          <Stack.Screen name="dev/local-privacy" />
        </Stack.Protected>
      </Stack>
      {/* One bar over the whole stack, so every screen keeps it — it hides
          itself on the modals and the camera. */}
      <AppTabBar />
      {/* A slim upload/download progress bar across the very top, over every
          screen — behind the `upload_progress` flag, so it renders nothing until
          the flag is on. */}
      <TransferProgressBar />
    </View>
  );
}
