/**
 * This phone's stable identity, for the device cap (free tier: two at a time).
 *
 * The id is generated once and kept in the device keystore, so a token refresh,
 * an app update or a new sign-in is still recognisably the same phone rather
 * than a third device that quietly pushes somebody over their limit. It is a
 * random id and nothing derived from hardware — a value the app owns and can
 * throw away on sign-out, not a fingerprint.
 *
 * Nothing here throws. A keystore read can fail (a locked device, a platform
 * without SecureStore), and the fallback is a fresh id for the session rather
 * than a crash at launch — the worst case is one extra row, never a blank app.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { randomUUID } from 'expo-crypto';
import Constants from 'expo-constants';
import * as Device from 'expo-device';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const KEY = 'baaki.device.id';

export interface DeviceIdentity {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: string;
  readonly appVersion: string | null;
}

// SecureStore has no web build; web falls back to AsyncStorage, which is enough
// for an id that is not a secret so much as a stable name.
async function readStoredId(): Promise<string | null> {
  try {
    return Platform.OS === 'web'
      ? await AsyncStorage.getItem(KEY)
      : await SecureStore.getItemAsync(KEY);
  } catch {
    return null;
  }
}

async function writeStoredId(id: string): Promise<void> {
  try {
    if (Platform.OS === 'web') await AsyncStorage.setItem(KEY, id);
    else await SecureStore.setItemAsync(KEY, id);
  } catch {
    /* a device that will not persist the id gets a fresh one next launch */
  }
}

let cached: string | null = null;
let pending: Promise<string> | null = null;

/** The stable id for this install, minted and stored on first ask. */
export async function deviceId(): Promise<string> {
  if (cached) return cached;
  // Memoize the in-flight mint so two callers can't both read null and mint
  // two different ids for one install.
  pending ??= (async () => {
    let id = await readStoredId();
    if (!id) {
      id = randomUUID();
      await writeStoredId(id);
    }
    cached = id;
    return id;
  })();
  try {
    return await pending;
  } finally {
    pending = null;
  }
}

/** Signing out must not leave the next account inheriting this device row. */
export async function clearDeviceId(): Promise<void> {
  cached = null;
  pending = null;
  try {
    if (Platform.OS === 'web') await AsyncStorage.removeItem(KEY);
    else await SecureStore.deleteItemAsync(KEY);
  } catch {
    /* nothing to undo */
  }
}

/** What a person would call this phone: its model, falling back to the OS. */
export function deviceLabel(): string {
  const model = Device.modelName ?? Device.deviceName ?? null;
  if (model) return model;
  return Platform.OS === 'ios'
    ? 'iPhone'
    : Platform.OS === 'android'
      ? 'Android phone'
      : 'This device';
}

/** The platform line under the label, e.g. "android 15". */
export function devicePlatform(): string {
  return Device.osVersion ? `${Platform.OS} ${Device.osVersion}` : Platform.OS;
}

export function appVersion(): string | null {
  return Constants.expoConfig?.version ?? null;
}

export async function deviceIdentity(): Promise<DeviceIdentity> {
  return {
    deviceId: await deviceId(),
    label: deviceLabel(),
    platform: devicePlatform(),
    appVersion: appVersion(),
  };
}
