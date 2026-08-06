import { useEffect } from 'react';
import * as Notifications from 'expo-notifications';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Button, ThemeProvider, Text, useTheme } from '@baaki/ui';

import { UpdateBanner, UpdateGate } from '@/components/UpdateGate';
import { AuthProvider, useAuth } from '@/lib/auth';
import { LockProvider, useLock } from '@/lib/lock';
import { MotionProvider, TRANSITION_MS, useMotion } from '@/lib/motion';
import { UpdateProvider } from '@/lib/update';
import { initObservability, withObservability } from '@/lib/observability';
import { ensureAndroidChannel, pushSupported, routeForNotification } from '@/lib/push';
import { SyncProvider } from '@/sync';

// Before anything else renders, so a crash in the first frame is still caught.
// Inert unless a DSN is configured.
initObservability();

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

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime pushes invalidations, so aggressive refetching is wasted work.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <SyncProvider>
              <LockProvider>
                <MotionProvider>
                  <UpdateProvider>
                    <ThemeProvider>
                      <StatusBar style="auto" />
                      {/* Outside the lock and the auth gate on purpose: a build
                          we have stopped trusting should not be unlocking a
                          ledger or signing anybody in either. */}
                      <UpdateGate>
                        <PushRouting />
                        <LockGate>
                          <AuthGate />
                        </LockGate>
                        {/* Last, so it paints over the screen rather than
                            under it. */}
                        <UpdateBanner />
                      </UpdateGate>
                    </ThemeProvider>
                  </UpdateProvider>
                </MotionProvider>
              </LockProvider>
            </SyncProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default withObservability(RootLayout);

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
    void Notifications.getLastNotificationResponseAsync().then((response) => {
      const route = response ? routeForNotification(response) : null;
      if (route) router.push(route as never);
    });

    const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
      const route = routeForNotification(response);
      if (route) router.push(route as never);
    });
    return () => subscription.remove();
  }, [router]);

  return null;
}

/** Holds the whole app behind biometrics when the user has asked for it. */
function LockGate({ children }: { children: React.ReactNode }) {
  const { locked, unlock } = useLock();
  const theme = useTheme();

  useEffect(() => {
    if (locked) void unlock();
  }, [locked, unlock]);

  if (!locked) return <>{children}</>;

  return (
    <View
      style={{
        flex: 1,
        alignItems: 'center',
        justifyContent: 'center',
        gap: theme.spacing.xl,
        backgroundColor: theme.color.bg,
        padding: theme.spacing.xxxl,
      }}
    >
      <Text style={{ fontSize: 44, lineHeight: 50, fontWeight: '700' }}>பாக்கி</Text>
      <Text variant="caption" tone="muted" align="center">
        Baaki is locked.
      </Text>
      <Button label="Unlock" size="lg" onPress={() => void unlock()} />
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

  /**
   * A push slides in from the right and a modal rises from the bottom, which is
   * how the screen says whether you have gone somewhere or opened something on
   * top. With motion off, both become `none` — not a faster slide, because a
   * shortened animation is still animation to somebody who cannot watch one.
   */
  const push = animated ? ('slide_from_right' as const) : ('none' as const);
  const sheet = animated ? ('slide_from_bottom' as const) : ('none' as const);
  const modal = { presentation: 'modal' as const, animation: sheet };

  useEffect(() => {
    if (loading) return;
    const onSignIn = segments[0] === 'sign-in';
    const onPublicRoute = onSignIn || segments[0] === 'join';
    if (!session && !onPublicRoute) router.replace('/sign-in');
    else if (session && onSignIn) router.replace('/');
  }, [session, loading, segments, router]);

  if (loading) {
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
      <Stack.Screen name="sign-in" options={{ animation: 'none' }} />
      <Stack.Screen name="(tabs)" options={{ animation: 'none' }} />
      <Stack.Screen name="new-group" options={modal} />
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
      <Stack.Screen name="friends/contacts" />
      <Stack.Screen name="settings/notifications" />
      <Stack.Screen name="settings/export" />
      <Stack.Screen name="settings/import" />
      <Stack.Screen name="settings/lock" />
      <Stack.Screen name="settings/motion" />
      <Stack.Screen name="settings/account" />
      <Stack.Screen name="join" />
      <Stack.Screen name="inbox" />
    </Stack>
  );
}
