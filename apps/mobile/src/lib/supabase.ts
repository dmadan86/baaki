import 'react-native-url-polyfill/auto';

import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { AppState, Platform } from 'react-native';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  // Fail loudly at start-up rather than with a confusing network error later.
  throw new Error(
    'EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY must be set. ' +
      'Copy .env.example to .env at the repo root and run `pnpm supabase:start`.',
  );
}

/**
 * The anon key is safe to ship: every table is behind RLS (ADR-013), so this
 * client can only ever see rows the signed-in user is entitled to. Service
 * credentials live in edge functions and never in the bundle.
 */
// Expo Router pre-renders web routes in Node, where there is no storage and no
// window; the client must construct there without touching either.
const isServer = typeof window === 'undefined';

export const supabase = createClient(url, anonKey, {
  auth: {
    storage: isServer ? undefined : AsyncStorage,
    autoRefreshToken: !isServer,
    persistSession: !isServer,
    // No URL-based session handoff on native; deep links are handled explicitly.
    detectSessionInUrl: !isServer && Platform.OS === 'web',
  },
});

// Refresh tokens only while the app is in front of the user.
if (!isServer) {
  AppState.addEventListener('change', (state) => {
    if (state === 'active') void supabase.auth.startAutoRefresh();
    else void supabase.auth.stopAutoRefresh();
  });
}
