import { useEffect } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Stack, useRouter, useSegments } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { ActivityIndicator, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { ThemeProvider, useTheme } from '@baaki/ui';

import { AuthProvider, useAuth } from '@/lib/auth';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Realtime pushes invalidations, so aggressive refetching is wasted work.
      staleTime: 30_000,
      retry: 1,
    },
  },
});

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <QueryClientProvider client={queryClient}>
          <AuthProvider>
            <ThemeProvider>
              <StatusBar style="auto" />
              <AuthGate />
            </ThemeProvider>
          </AuthProvider>
        </QueryClientProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
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
      <Stack.Screen name="join" />
    </Stack>
  );
}
