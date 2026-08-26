/**
 * The mirror's at-rest cipher (rowCipher.ts).
 *
 * The pure core (seal/open/base64) runs with a fixed key and nonce so the crypto
 * round-trips are deterministic. The native layer (loadKey/encryptWith/
 * decryptWith/destroyKey) runs against an in-memory keystore and Node's CSPRNG,
 * standing in for expo-secure-store and expo-crypto; @noble/ciphers itself is
 * pure JS and runs for real.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  base64ToBytes,
  bytesToBase64,
  decryptWith,
  destroyKey,
  encryptWith,
  isSealed,
  loadKey,
  open,
  seal,
} from '../src/sync/rowCipher';

// vi.mock is hoisted above the imports by vitest, so the stand-ins are in place
// before rowCipher.ts loads expo-secure-store / expo-crypto.
const hoisted = vi.hoisted(() => ({ keystore: new Map<string, string>() }));

vi.mock('expo-secure-store', () => ({
  AFTER_FIRST_UNLOCK: 'after-first-unlock',
  AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY: 'after-first-unlock-this-device-only',
  getItemAsync: async (key: string) => hoisted.keystore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    hoisted.keystore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    hoisted.keystore.delete(key);
  },
}));

vi.mock('expo-crypto', () => ({
  getRandomBytes: (length: number) => {
    const bytes = new Uint8Array(length);
    globalThis.crypto.getRandomValues(bytes);
    return bytes;
  },
}));

const KEY = new Uint8Array(32).fill(7);
const NONCE = new Uint8Array(24).fill(3);

beforeEach(async () => {
  hoisted.keystore.clear();
  await destroyKey(); // drop the cached key between tests
  hoisted.keystore.clear();
});

describe('base64', () => {
  it('round-trips byte arrays of every remainder length', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 17, 24, 100]) {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      expect([...base64ToBytes(bytesToBase64(bytes))]).toEqual([...bytes]);
    }
  });
});

describe('seal / open (pure)', () => {
  it('round-trips a value', () => {
    const plain = JSON.stringify({ id: 'e1', amount: '100', note: 'café ☕' });
    const sealed = seal(KEY, NONCE, plain);
    expect(isSealed(sealed)).toBe(true);
    expect(open(KEY, sealed)).toBe(plain);
  });

  it('passes legacy plaintext through unchanged', () => {
    const legacy = JSON.stringify({ id: 'e1' });
    expect(isSealed(legacy)).toBe(false);
    expect(open(KEY, legacy)).toBe(legacy);
  });

  it('throws on a tampered ciphertext', () => {
    const sealed = seal(KEY, NONCE, 'hello world');
    const raw = base64ToBytes(sealed.slice('v1:'.length));
    raw[NONCE.length + 1] ^= 0xff; // flip a ciphertext byte
    const tampered = 'v1:' + bytesToBase64(raw);
    expect(() => open(KEY, tampered)).toThrow();
  });

  it('cannot be opened with the wrong key', () => {
    const sealed = seal(KEY, NONCE, 'secret');
    const wrong = new Uint8Array(32).fill(9);
    expect(() => open(wrong, sealed)).toThrow();
  });

  it('binds the ciphertext to its associated data', () => {
    const plain = JSON.stringify({ id: 'e1' });
    const sealed = seal(KEY, NONCE, plain, 'mirror_rows\x1fe1\x1fg1\x1f5');
    // Same context opens it...
    expect(open(KEY, sealed, 'mirror_rows\x1fe1\x1fg1\x1f5')).toBe(plain);
    // ...but the same blob "moved" to another row (different id/group/seq) fails,
    // and so does opening with no context at all.
    expect(() => open(KEY, sealed, 'mirror_rows\x1fe2\x1fg1\x1f5')).toThrow();
    expect(() => open(KEY, sealed, 'mirror_rows\x1fe1\x1fg2\x1f5')).toThrow();
    expect(() => open(KEY, sealed)).toThrow();
  });
});

describe('key-backed layer', () => {
  it('encrypts then decrypts through the loaded key', async () => {
    const key = await loadKey();
    const plain = JSON.stringify({ amount: '250' });
    expect(decryptWith(key, encryptWith(key, plain))).toBe(plain);
  });

  it('uses a fresh nonce each time (distinct ciphertexts)', async () => {
    const key = await loadKey();
    expect(encryptWith(key, 'same')).not.toBe(encryptWith(key, 'same'));
  });

  it('loads the same key across calls, then mints a new one after destroy', async () => {
    const first = await loadKey();
    const again = await loadKey();
    expect([...again]).toEqual([...first]);

    await destroyKey();
    const minted = await loadKey();
    expect([...minted]).not.toEqual([...first]);
  });
});
