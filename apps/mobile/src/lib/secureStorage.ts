import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

/**
 * A Supabase auth-storage adapter that keeps the session — access **and**
 * refresh token — in the OS keystore (Keychain / Keystore) via expo-secure-store
 * instead of AsyncStorage, which is plaintext app-private storage recoverable on
 * a rooted device or from a backup. The refresh token is the crown jewel: it
 * mints access tokens indefinitely, so it must not sit in the clear.
 *
 * SecureStore rejects values past ~2KB on Android and the session JSON (a JWT
 * plus a refresh token) is bigger, so values are split into chunks. A stored
 * `<key>.pn` holds the chunk count; `<key>.p0..pn-1` hold the pieces.
 *
 * Web has no SecureStore; there it falls back to AsyncStorage (the previous,
 * unchanged behaviour) — the web session model is localStorage-based anyway.
 */

const CHUNK = 1800;
const countKey = (key: string) => `${key}.pn`;
const partKey = (key: string, i: number) => `${key}.p${i}`;

const isWeb = Platform.OS === 'web';
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
};

// Keys whose legacy plaintext has been cleared this process. If the removal
// fails, the key is left out so a later read retries — otherwise the marker is
// already in SecureStore and the plaintext would sit in AsyncStorage forever.
const legacyCleared = new Set<string>();

async function getItem(key: string): Promise<string | null> {
  if (isWeb) return AsyncStorage.getItem(key);

  const countRaw = await SecureStore.getItemAsync(countKey(key));
  if (countRaw === null) {
    // One-time migration: a session written by the old AsyncStorage adapter is
    // adopted into SecureStore on first read, so upgrading does not sign anyone
    // out. Removed from AsyncStorage once it is safely in the keystore.
    const legacy = await AsyncStorage.getItem(key);
    if (legacy !== null) {
      await setItem(key, legacy);
      legacyCleared.add(key);
      await AsyncStorage.removeItem(key).catch(() => legacyCleared.delete(key));
    }
    return legacy;
  }

  // Already migrated. If an earlier cleanup rejected, the plaintext copy is
  // still in AsyncStorage; retry its removal so it does not linger in the clear.
  if (!legacyCleared.has(key)) {
    legacyCleared.add(key);
    void AsyncStorage.removeItem(key).catch(() => legacyCleared.delete(key));
  }

  const count = Number(countRaw);
  if (!Number.isInteger(count) || count < 1) return null;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = await SecureStore.getItemAsync(partKey(key, i));
    if (part === null) return null; // a torn write is no session, not half of one
    parts.push(part);
  }
  return parts.join('');
}

async function setItem(key: string, value: string): Promise<void> {
  if (isWeb) return AsyncStorage.setItem(key, value);

  const prev = Number(await SecureStore.getItemAsync(countKey(key))) || 0;
  const count = Math.max(1, Math.ceil(value.length / CHUNK));
  await SecureStore.setItemAsync(countKey(key), String(count), SECURE_OPTIONS);
  for (let i = 0; i < count; i++) {
    await SecureStore.setItemAsync(
      partKey(key, i),
      value.slice(i * CHUNK, (i + 1) * CHUNK),
      SECURE_OPTIONS,
    );
  }
  // A shorter new value leaves orphan chunks from the old one; clear them.
  for (let i = count; i < prev; i++) {
    await SecureStore.deleteItemAsync(partKey(key, i));
  }
}

async function removeItem(key: string): Promise<void> {
  if (isWeb) return AsyncStorage.removeItem(key);

  const count = Number(await SecureStore.getItemAsync(countKey(key))) || 0;
  for (let i = 0; i < count; i++) {
    await SecureStore.deleteItemAsync(partKey(key, i));
  }
  await SecureStore.deleteItemAsync(countKey(key));
}

export const secureAuthStorage = { getItem, setItem, removeItem };
