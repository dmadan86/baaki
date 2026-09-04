/**
 * The user-held backup key: how it is written down, how it is read back, and
 * what happens when the wrong one is presented to a sealed backup.
 *
 * The last of those is the one that matters. The whole key model rests on a
 * backup being *unopenable* without the key, and on a file from one account
 * being unopenable under another's associated data — so both are asserted here
 * against the real cipher rather than taken on trust.
 */

import { describe, expect, it, vi } from 'vitest';

// Hoisted above the imports so the stand-ins are in place before recoveryKey.ts
// loads expo-secure-store / expo-crypto.
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

const {
  RECOVERY_KEY_LENGTH,
  bytesToHex,
  formatRecoveryKey,
  mintRecoveryKey,
  openBackup,
  parseRecoveryKey,
  sealBackup,
} = await import('../src/lib/backup/recoveryKey');
const { backupAad } = await import('../src/lib/backup/payload');

const NONCE = new Uint8Array(24).fill(9);
const OWNER = 'owner-1';

describe('minting a key', () => {
  it('is 32 bytes — 64 hexadecimal characters when written down', () => {
    const key = mintRecoveryKey();
    expect(key).toHaveLength(32);
    expect(bytesToHex(key)).toHaveLength(RECOVERY_KEY_LENGTH);
  });

  it('is different every time', () => {
    expect(bytesToHex(mintRecoveryKey())).not.toBe(bytesToHex(mintRecoveryKey()));
  });
});

describe('reading a key off a screen and typing it back', () => {
  const hex = 'a'.repeat(8) + 'b'.repeat(8) + '0123456789abcdef'.repeat(3);

  it('shows 16 groups of 4, upper case', () => {
    const shown = formatRecoveryKey(hex);
    expect(shown.split(' ')).toHaveLength(16);
    expect(shown).toBe(shown.toUpperCase());
  });

  it('reads back exactly what was shown', () => {
    expect(bytesToHex(parseRecoveryKey(formatRecoveryKey(hex))!)).toBe(hex);
  });

  it('forgives spaces, dashes and case, because people paste from anywhere', () => {
    const messy = `  ${hex.slice(0, 32).toUpperCase()} - ${hex.slice(32)}\n`;
    expect(bytesToHex(parseRecoveryKey(messy)!)).toBe(hex);
  });

  it('refuses anything that is not exactly 64 hex characters', () => {
    expect(parseRecoveryKey('')).toBeNull();
    expect(parseRecoveryKey(hex.slice(0, 63))).toBeNull();
    expect(parseRecoveryKey(hex + '0')).toBeNull();
    expect(parseRecoveryKey('z'.repeat(64))).toBeNull();
  });
});

describe('sealing a backup', () => {
  const key = parseRecoveryKey('11'.repeat(32))!;
  const other = parseRecoveryKey('22'.repeat(32))!;
  const plain = JSON.stringify({ ownerId: OWNER, records: [{ id: 'a' }] });

  it('round-trips under the right key and the right owner', () => {
    const sealed = sealBackup(key, NONCE, plain, backupAad(OWNER));
    expect(openBackup(key, sealed, backupAad(OWNER))).toBe(plain);
  });

  it('leaves nothing of the ledger legible in the sealed form', () => {
    const sealed = sealBackup(key, NONCE, plain, backupAad(OWNER));
    expect(sealed).not.toContain(OWNER);
    expect(sealed).not.toContain('records');
  });

  it('will not open under the wrong key — the whole premise of the model', () => {
    const sealed = sealBackup(key, NONCE, plain, backupAad(OWNER));
    expect(() => openBackup(other, sealed, backupAad(OWNER))).toThrow();
  });

  it('will not open under another account, even with the right key', () => {
    const sealed = sealBackup(key, NONCE, plain, backupAad(OWNER));
    expect(() => openBackup(key, sealed, backupAad('somebody-else'))).toThrow();
  });

  it('will not open once a byte has been changed', () => {
    const sealed = sealBackup(key, NONCE, plain, backupAad(OWNER));
    const tampered = `${sealed.slice(0, -4)}${sealed.slice(-4) === 'AAAA' ? 'BBBB' : 'AAAA'}`;
    expect(() => openBackup(key, tampered, backupAad(OWNER))).toThrow();
  });
});
