import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Button, ThemeProvider, Text, useTheme } from '@baaki/ui';

import { AuthProvider, useAuth } from '@/lib/auth';
import { LockProvider, useLock } from '@/lib/lock';
import { initObservability, withObservability } from '@/lib/observability';
import { SyncProvider } from '@/sync';

// Before anything else renders, so a crash in the first frame is still caught.
// Inert unless a DSN is configured.
initObservability();

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
                <ThemeProvider>
                  <StatusBar style="auto" />
                  <LockGate>
                    <AuthGate />
                  </LockGate>
                </ThemeProvider>
              </LockProvider>
            </SyncProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

export default withObservability(RootLayout);

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
      }}
    >
      <Stack.Screen name="sign-in" />
      <Stack.Screen name="(tabs)" />
      <Stack.Screen name="new-group" options={{ presentation: 'modal' }} />
      <Stack.Screen name="group/[id]/index" />
      <Stack.Screen
        name="group/[id]/add-expense"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="group/[id]/settle"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen name="group/[id]/simplify" />
      <Stack.Screen name="group/[id]/settings" />
      <Stack.Screen name="group/[id]/members" />
      <Stack.Screen name="group/[id]/member/[memberId]" />
      <Stack.Screen name="group/[id]/expense/[expenseId]" />
      <Stack.Screen
        name="group/[id]/invite"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen
        name="group/[id]/itemize"
        options={{ presentation: 'modal', animation: 'slide_from_bottom' }}
      />
      <Stack.Screen name="settings/notifications" />
      <Stack.Screen name="settings/export" />
      <Stack.Screen name="settings/lock" />
      <Stack.Screen name="settings/account" />
      <Stack.Screen name="join" />
    </Stack>
  );
}
