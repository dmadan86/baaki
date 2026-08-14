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
 *
 * **Nothing here throws.** Asking for a token is a network call into FCM (on
 * Android) or APNs (on iOS) by way of Expo, and it rejects for reasons that
 * have nothing to do with the person holding the phone: no
 * `google-services.json` in this build, a Firebase project with the wrong
 * package name, an aeroplane. `refreshPushToken` is called with `void` on
 * every sign-in, so a rejection there is an unhandled one at launch. The
 * failures come back as a reason instead, and the notifications screen says
 * which one it was.
 */

import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';

import { supabase } from './supabase';

/**
 * Whether this platform has push at all.
 *
 * expo-notifications has no web implementation: calling into it there throws
 * "not available on web, are you sure you've linked all the native
 * dependencies", which takes the whole app down rather than degrading. Web is
 * how this repo does visual checks, so an unguarded call is a blank screen
 * every time somebody looks at it.
 */
export const pushSupported = Platform.OS === 'ios' || Platform.OS === 'android';

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

export enum PushPermission {
  Granted = 'granted',
  Denied = 'denied',
  Undetermined = 'undetermined',
}

export async function pushPermission(): Promise<PushPermission> {
  if (!pushSupported || !Device.isDevice) return PushPermission.Denied;
  const { status } = await Notifications.getPermissionsAsync();
  return status === 'granted'
    ? PushPermission.Granted
    : status === 'undetermined'
      ? PushPermission.Undetermined
      : PushPermission.Denied;
}

/**
 * Why registering did not happen. Only `denied` is the person's doing; the
 * others are this app's, and telling somebody to check their phone settings
 * when the real problem is a missing Firebase key sends them somewhere that
 * cannot help them.
 */
export enum PushFailure {
  /** Web, or a simulator — neither has a push token to give. */
  Unsupported = 'unsupported',
  /** They said no, which is an answer. */
  Denied = 'denied',
  /** Nobody is signed in, so there is no profile to hang the token on. */
  NotSignedIn = 'not_signed_in',
  /** This build has no FCM/APNs credentials. Ours to fix, not theirs. */
  NotConfigured = 'not_configured',
  /** We got a token and could not store it. */
  SaveFailed = 'save_failed',
}

export type PushResult = { readonly ok: true } | { readonly ok: false; readonly why: PushFailure };

/**
 * Ask, register, and store. A refusal comes back as `denied` — an answer, not
 * an error, and the caller should treat it as one.
 */
export async function enablePush(): Promise<PushResult> {
  // A simulator has no push token to give, and web has no push at all. Failing
  // loudly here would make every development run look broken.
  if (!pushSupported || !Device.isDevice) return { ok: false, why: PushFailure.Unsupported };

  const existing = await Notifications.getPermissionsAsync();
  const status =
    existing.status === 'granted'
      ? existing.status
      : (await Notifications.requestPermissionsAsync()).status;
  if (status !== 'granted') return { ok: false, why: PushFailure.Denied };

  // Android 13+ wants the channel to exist before the token is asked for.
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
export async function refreshPushToken(): Promise<PushResult> {
  if (!pushSupported || !Device.isDevice) return { ok: false, why: PushFailure.Unsupported };
  const { status } = await Notifications.getPermissionsAsync();
  if (status !== 'granted') return { ok: false, why: PushFailure.Denied };

  const id = projectId();
  if (!id) return { ok: false, why: PushFailure.NotConfigured };

  const { data: session } = await supabase.auth.getSession();
  const profileId = session.session?.user?.id;
  if (!profileId) return { ok: false, why: PushFailure.NotSignedIn };

  let token: string;
  try {
    token = (await Notifications.getExpoPushTokenAsync({ projectId: id })).data;
  } catch (caught) {
    // The usual one, on an Android build with no `google-services.json`:
    // "Default FirebaseApp is not initialized". Also a Firebase project whose
    // package name is not `app.baaki.mobile`, and a device with no network.
    // None of them are anything the person can act on, and none of them are
    // worth taking the app down for.
    console.warn('push token unavailable:', (caught as Error).message);
    return { ok: false, why: PushFailure.NotConfigured };
  }

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
  return error ? { ok: false, why: PushFailure.SaveFailed } : { ok: true };
}

/** On the way out. Leaves the row, so a return is recognised as a return. */
export async function revokePushToken(): Promise<void> {
  if (!pushSupported || !Device.isDevice) return;
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
