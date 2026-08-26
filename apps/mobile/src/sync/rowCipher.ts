/**
 * At-rest encryption for the offline mirror's payloads (ADR-005 durability +
 * privacy).
 *
 * The mirror is a plain SQLite file in the app sandbox (`driver.ts`). The
 * sandbox and full-disk encryption keep it from other apps and from a powered-
 * off, locked device — but a rooted/jailbroken phone or a file-level backup can
 * read that file, and it holds the whole ledger: groups, expenses, splits,
 * balances, the mutation queue, autosaved drafts. So every value SQLite stores
 * in a `json` column is sealed here before it is written and opened after it is
 * read.
 *
 * Why application-layer and not SQLCipher: the sensitive content lives *only* in
 * the `json` columns, always read and written whole — no query ever filters or
 * sorts on it (see the SELECTs in `driver.ts`). Sealing that one column covers
 * the payload without swapping the native SQLite module, which on this Expo pin
 * would break autolinking (see the RN 0.87 revert). This is pure JS: a
 * ChaCha-family AEAD from `@noble/ciphers`, a random nonce per value, and a
 * 256-bit data-encryption key kept in the OS keystore.
 *
 * Trust boundary: this protects data *at rest* against off-device extraction,
 * rooted-filesystem access and backup theft. It does not defend a running,
 * unlocked, compromised device — the key is available to the app at runtime,
 * the same posture as the session token and BYOK model keys already held in
 * SecureStore (see `secureStorage.ts`, `aiKeys.ts`). A lock-gated key is a
 * possible future hardening, deliberately out of scope here.
 *
 * The module splits into a pure core (`seal`/`open`, key and nonce passed in,
 * no native imports) so the crypto round-trips can be unit-tested, and a thin
 * native layer (`loadKey`/`encryptWith`/`decryptWith`/`destroyKey`) that owns
 * the keystore and the RNG.
 */

import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { bytesToUtf8, concatBytes, utf8ToBytes } from '@noble/ciphers/utils.js';
import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

/** Marks a sealed value. An unprefixed value is legacy plaintext (see `open`). */
const VERSION_TAG = 'v1:';
/** XChaCha20 takes a 192-bit (24-byte) nonce — wide enough that a random nonce
 *  per value never collides in practice, so no counter to persist. */
const NONCE_BYTES = 24;
/** ChaCha20-Poly1305 key length. */
const KEY_BYTES = 32;
/** The keystore slot the data-encryption key lives in. */
const DEK_STORE_KEY = 'waves.mirror.dek.v1';

/** An opaque 256-bit key. Only this module should construct one. */
export type MirrorKey = Uint8Array;

// --- base64 (pure, no reliance on Hermes btoa/atob) -------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP: Record<string, number> = {};
for (let i = 0; i < B64_CHARS.length; i += 1) B64_LOOKUP[B64_CHARS[i] as string] = i;

export function bytesToBase64(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n =
      ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8) | (bytes[i + 2] as number);
    out +=
      B64_CHARS[(n >> 18) & 63] +
      B64_CHARS[(n >> 12) & 63] +
      B64_CHARS[(n >> 6) & 63] +
      B64_CHARS[n & 63];
  }
  const rem = bytes.length - i;
  if (rem === 1) {
    const n = (bytes[i] as number) << 16;
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + '==';
  } else if (rem === 2) {
    const n = ((bytes[i] as number) << 16) | ((bytes[i + 1] as number) << 8);
    out += B64_CHARS[(n >> 18) & 63] + B64_CHARS[(n >> 12) & 63] + B64_CHARS[(n >> 6) & 63] + '=';
  }
  return out;
}

export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '');
  const outLen = Math.floor((clean.length * 6) / 8);
  const out = new Uint8Array(outLen);
  let bits = 0;
  let val = 0;
  let oi = 0;
  for (let i = 0; i < clean.length; i += 1) {
    val = (val << 6) | (B64_LOOKUP[clean[i] as string] as number);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[oi] = (val >> bits) & 0xff;
      oi += 1;
    }
  }
  return out;
}

// --- pure core --------------------------------------------------------------

/** True if `stored` is a sealed value rather than legacy plaintext. */
export function isSealed(stored: string): boolean {
  return stored.startsWith(VERSION_TAG);
}

/** Seal `plain` with `key` and a caller-supplied `nonce`. Pure — the native
 *  layer supplies a random nonce; tests can pin one. */
export function seal(key: MirrorKey, nonce: Uint8Array, plain: string): string {
  const ct = xchacha20poly1305(key, nonce).encrypt(utf8ToBytes(plain));
  return VERSION_TAG + bytesToBase64(concatBytes(nonce, ct));
}

/** Open a value sealed by {@link seal}. A value without the version tag is
 *  returned unchanged — that is a row written before encryption existed, and
 *  the next write will seal it. A tampered/corrupt sealed value throws (the
 *  AEAD tag fails), exactly as a corrupt plaintext row would fail `JSON.parse`. */
export function open(key: MirrorKey, stored: string): string {
  if (!isSealed(stored)) return stored;
  const raw = base64ToBytes(stored.slice(VERSION_TAG.length));
  const nonce = raw.subarray(0, NONCE_BYTES);
  const ct = raw.subarray(NONCE_BYTES);
  return bytesToUtf8(xchacha20poly1305(key, nonce).decrypt(ct));
}

// --- native layer: keystore-backed key + RNG --------------------------------

// The key is fetched from the keystore once and cached for the process. A
// failed load is not cached, so a transient keystore error at launch does not
// permanently wedge the store (mirrors the open-retry logic in driver.ts).
let keyPromise: Promise<MirrorKey> | null = null;

async function loadOrCreateKey(): Promise<MirrorKey> {
  const existing = await SecureStore.getItemAsync(DEK_STORE_KEY);
  if (existing) return base64ToBytes(existing);
  const key = Crypto.getRandomBytes(KEY_BYTES);
  await SecureStore.setItemAsync(DEK_STORE_KEY, bytesToBase64(key), {
    // Readable after the first unlock following a boot, so background sync can
    // decrypt without the user having just unlocked — but not before first
    // unlock, and never in an iCloud/iTunes backup.
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK,
  });
  return key;
}

/** The mirror's data-encryption key, loading (or minting) it once. Callers hold
 *  the resolved key and run {@link encryptWith}/{@link decryptWith} synchronously
 *  per row, so a hydration loop pays the keystore cost once, not per value. */
export function loadKey(): Promise<MirrorKey> {
  keyPromise ??= loadOrCreateKey().catch((error) => {
    keyPromise = null;
    throw error;
  });
  return keyPromise;
}

/** Seal `plain` with a fresh random nonce. Synchronous given a loaded key. */
export function encryptWith(key: MirrorKey, plain: string): string {
  return seal(key, Crypto.getRandomBytes(NONCE_BYTES), plain);
}

/** Open `stored` (legacy plaintext passes through). Synchronous given a key. */
export function decryptWith(key: MirrorKey, stored: string): string {
  return open(key, stored);
}

/**
 * Destroy the data-encryption key. Called on sign-out after the rows are wiped:
 * any ciphertext still physically present in the file's WAL or free pages is
 * then unrecoverable, and the next account mints a fresh key.
 */
export async function destroyKey(): Promise<void> {
  keyPromise = null;
  await SecureStore.deleteItemAsync(DEK_STORE_KEY);
}
