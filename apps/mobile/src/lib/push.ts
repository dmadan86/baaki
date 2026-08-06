/**
 * Registering this device to be tapped on the shoulder.
 *
 * Two decisions worth stating, because both are easy to get wrong in a way
 * nobody notices:
 *
 * **Permission is never asked for on launch.** A money app that opens with
 * "Baaki would like to send you notifications" gets denied, and on iOS a denial
 * is close to permanent — the only way back is Settings, which nobody visits.
 * So the prompt happens when somebody turns notifications on, having read what
 * they are for. If permission is already granted the token is refreshed
 * silently, because that costs nothing and a stale token is a person who
 * quietly stops hearing from us.
 *
 * **Signing out revokes the token rather than deleting the row.** The same
 * token coming back later is the same device, and the row is the evidence of
 * that.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from './supabase';

/** Android delivers silently without a channel, which looks exactly like a bug. */
export async function ensureAndroidChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await Notifications.setNotificationChannelAsync('default', {
    name: 'Baaki',
    importance: Notifications.AndroidImportance.DEFAULT,
    vibrationPattern: [0, 200, 100, 200],
    lightColor: '#7A5AF8',
  });
}

function projectId(): string | null {
  const extra = Constants.expoConfig?.extra as { eas?: { projectId?: string } } | undefined;
  return extra?.eas?.projectId ?? null;
}

export type PushPermission = 'granted' | 'denied' | 'undetermined';

export async function pushPermission(): Promise<PushPermission> {
  if (!Device.isDevice) return 'denied';
  const { status } = await Notifications.getPermissionsAsync();
  return status as PushPermission;
}

/**
 * Ask, register, and store. Returns false when the person said no — which is an
 * answer, not an error, and the caller should treat it as one.
 */
export async function enablePush(): Promise<boolean> {
  // A simulator has no push token to give. Failing loudly here would make every
  // development run look broken.
  if (!Device.isDevice) return false;

  const existing = await Notifications.getPermissionsAsync();
  const status =
    existing.status === 'granted'
      ? existing.status
      : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return false;

  await ensureAndroidChannel();
  return refreshPushToken();
}

/**
 * Store the current token if we already have permission.
 *
 * Safe to call on every launch: it is a no-op without permission, and a token
 * can change on its own (a restore, a reinstall), at which point the old one
 * silently stops working.
 */
export async function refreshPushToken(): Promise<boolean> {
  if (!Device.isDevice) return false;
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return false;

  const id = projectId();
  if (!id) return false;

  const { data: session } = await supabase.auth.getSession();
  const profileId = session.session?.user?.id;
  if (!profileId) return false;

  const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;

  const { error } = await supabase.from('push_tokens').upsert(
    {
      profile_id: profileId,
      expo_push_token: token,
      platform: Platform.OS === 'ios' ? 'ios' : 'android',
      device_name: Device.modelName,
      last_seen_at: new Date().toISOString(),
      // A token that comes back is the same device returning, not a new one.
      revoked_at: null,
    },
    { onConflict: 'expo_push_token' },
  );
  return !error;
}

/** On the way out. Leaves the row, so a return is recognised as a return. */
export async function revokePushToken(): Promise<void> {
  if (!Device.isDevice) return;
  const id = projectId();
  if (!id) return;
  try {
    const token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
    await supabase
      .from('push_tokens')
      .update({ revoked_at: new Date().toISOString() })
      .eq('expo_push_token', token);
  } catch {
    // Signing out must succeed whether or not this does. A token left live
    // sends notifications to a phone nobody is signed in on, which the app
    // discards — untidy, not harmful.
  }
}

/**
 * Where a tapped notification should go.
 *
 * Returned rather than navigated to, so the caller decides when the router is
 * ready — a deep link fired before the navigation tree exists goes nowhere.
 */
export function routeForNotification(response: Notifications.NotificationResponse): string | null {
  const data = response.notification.request.content.data as { url?: unknown } | undefined;
  const url = typeof data?.url === 'string' ? data.url : null;
  if (!url) return null;
  // `baaki://group/<id>` → `/group/<id>`. The scheme is only there because a
  // push has to survive being handed to the operating system.
  return url.replace(/^baaki:\/\//, '/');
}
