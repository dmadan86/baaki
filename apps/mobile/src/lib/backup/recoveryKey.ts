/**
 * The key model for a backup that has to survive the phone it was made on.
 *
 * THE TENSION. The offline mirror is already encrypted at rest (`sync/
 * rowCipher.ts`) with a 256-bit key minted on the device and kept in the OS
 * keystore under `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY`. That flag is not an
 * accident: it stops the key travelling in an iCloud or Android backup, so a
 * restored copy of the SQLite file is unreadable on a new phone. Which is
 * exactly right for a local cache — and exactly wrong for a backup, whose only
 * job is to be readable on a new phone. Sealing the Drive file with the mirror
 * DEK would produce a file nobody, including its owner, could ever open again.
 *
 * THE THREE OPTIONS, and why this one.
 *
 * 1. *Upload it in the clear.* Then the personal ledger — every solo expense,
 *    every loan, every income line — is readable by anyone who reaches the
 *    Google account, and by Google. The whole premise of the "Me" tab is that
 *    it is private; a backup that quietly undoes that is worse than no backup.
 *    Rejected.
 *
 * 2. *A password the user picks.* Nicest to use, and what most people expect.
 *    But a human-chosen password has maybe 30 bits of entropy against a file an
 *    attacker can copy and grind offline forever, so it is only safe behind a
 *    memory-hard KDF — Argon2id or scrypt with real parameters. That is a new
 *    crypto dependency and a tuning decision (a KDF slow enough to matter on a
 *    laptop is slow on a five-year-old Android), and getting either wrong
 *    produces something that *looks* encrypted. Deliberately not done here.
 *
 * 3. *A key the app generates.* 32 random bytes, shown to the person once as 64
 *    hexadecimal characters, kept in this device's keystore for convenience,
 *    and typed in on any new device that wants to restore. Full 256-bit
 *    entropy, so there is nothing to grind and no KDF to get wrong: the key is
 *    used directly as the XChaCha20-Poly1305 key, through the same `seal`/`open`
 *    the mirror uses. This is WhatsApp's "64-digit encryption key" option,
 *    minus the password option beside it.
 *
 * THE COST, said plainly: **lose the key and the backup is gone.** Nobody can
 * recover it — not Waves, which never sees it, and not Google, which holds only
 * ciphertext. The screen says this before it makes one, and refuses to make a
 * backup until the person has been shown the key.
 *
 * A future password option can be added beside this without changing the file
 * format: the envelope already names its algorithm, and a password variant
 * would add a `kdf` block rather than replace anything.
 */

import * as Crypto from 'expo-crypto';
import * as SecureStore from 'expo-secure-store';

import { open, seal, type MirrorKey } from '@/sync/rowCipher';

/** XChaCha20-Poly1305 key length, and so the recovery key's length. */
const KEY_BYTES = 32;
/** XChaCha20 takes a 192-bit nonce; a random one per file never collides. */
const NONCE_BYTES = 24;
/** 32 bytes as hex. What the person copies down. */
export const RECOVERY_KEY_LENGTH = KEY_BYTES * 2;
/** Shown in blocks of this many characters, so it can be read off a screen. */
const GROUP = 4;

/**
 * The keystore slot this device's copy of the key lives in, per account.
 *
 * The owner id is load-bearing on a shared phone: a key is what opens one
 * account's backup, and an unscoped slot would hand B the key to A's file
 * (and, with the tokens beside it, the ability to overwrite it).
 */
const keySlot = (ownerId: string): string => `waves.backup.recovery_key.v1.${ownerId}`;

// ─────────────────────────────────────────────────────────────── pure ──

const HEX = '0123456789abcdef';

export function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 1) {
    const byte = bytes[i] as number;
    out += HEX[(byte >> 4) & 15];
    out += HEX[byte & 15];
  }
  return out;
}

/**
 * The key as somebody reads it off a screen: 16 groups of 4, upper case. Hex is
 * ambiguous read aloud (b/d, 0/o), so the screen never asks anybody to only read
 * it aloud — it is selectable and there is a Copy button. The groups are for
 * checking a transcription, not for making one.
 */
export function formatRecoveryKey(hex: string): string {
  const groups: string[] = [];
  for (let i = 0; i < hex.length; i += GROUP) groups.push(hex.slice(i, i + GROUP));
  return groups.join(' ').toUpperCase();
}

/**
 * Read a typed or pasted key back. Spaces, dashes and case are all forgiven —
 * people paste from anywhere — but a string that is not exactly 64 hex
 * characters is rejected rather than padded, because a key that is nearly right
 * decrypts nothing and "almost" is not a state worth carrying forward.
 */
export function parseRecoveryKey(input: string): Uint8Array | null {
  const hex = input.trim().toLowerCase().replace(/[\s-]/g, '');
  if (hex.length !== RECOVERY_KEY_LENGTH) return null;
  if (!/^[0-9a-f]+$/.test(hex)) return null;
  const bytes = new Uint8Array(KEY_BYTES);
  for (let i = 0; i < KEY_BYTES; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Seal a backup body. Same AEAD, same tagged format as the mirror's rows — the
 * crypto is not re-implemented here, only pointed at a different key and a
 * different associated-data string.
 */
export function sealBackup(key: MirrorKey, nonce: Uint8Array, plain: string, aad: string): string {
  return seal(key, nonce, plain, aad);
}

/** Open a sealed backup body. Throws when the key or the `aad` is wrong. */
export function openBackup(key: MirrorKey, sealed: string, aad: string): string {
  return open(key, sealed, aad);
}

// ───────────────────────────────────────────────────────────── native ──

/** A fresh 256-bit key. Not stored — the caller decides when it is committed. */
export function mintRecoveryKey(): Uint8Array {
  return Crypto.getRandomBytes(KEY_BYTES);
}

/** A fresh nonce for one sealed file. */
export function backupNonce(): Uint8Array {
  return Crypto.getRandomBytes(NONCE_BYTES);
}

/**
 * This device's copy of `ownerId`'s key, or null when there is none — a fresh
 * install has none, which is precisely the case where the person has to type
 * theirs in.
 */
export async function loadRecoveryKey(ownerId: string): Promise<Uint8Array | null> {
  if (!ownerId) return null;
  const hex = await SecureStore.getItemAsync(keySlot(ownerId)).catch(() => null);
  return hex ? parseRecoveryKey(hex) : null;
}

export async function saveRecoveryKey(ownerId: string, key: Uint8Array): Promise<void> {
  if (!ownerId) return;
  await SecureStore.setItemAsync(keySlot(ownerId), bytesToHex(key), {
    // Same posture as the mirror's own key: readable after the first unlock
    // since a foreground backup can run without the person having just
    // authenticated, and never migrated to another device by an OS backup —
    // the point of the printed key is that it, and not iCloud, is what moves.
    keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY,
  });
}

/**
 * Forget this device's copy. The backup stays readable to whoever has the key.
 *
 * Does not swallow: an unlink should say when it failed, and on sign-out a key
 * left in the keystore is a privacy problem rather than a cosmetic one.
 */
export async function clearRecoveryKey(ownerId: string): Promise<void> {
  if (!ownerId) return;
  await SecureStore.deleteItemAsync(keySlot(ownerId));
}
