/**
 * Stable ids for drafts made from bank SMS.
 *
 * The same bank message is allowed to appear on a shared phone for several
 * signed-in people: one person paid, another traveller imports the same cab SMS,
 * and a financer later checks the same statement. The dedupe key alone is not
 * the identity of a draft; the owner is part of the seed so one person's import
 * cannot erase another person's.
 */

import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
  digestStringAsync: async (_algorithm: string, value: string) =>
    createHash('sha256').update(value).digest('hex'),
}));

const { smsCaptureId } = await import('@/lib/smsCaptureId');

const MESSAGE_KEY = 'ref:412703998812';

describe('smsCaptureId', () => {
  it('is stable for the same user and bank message', async () => {
    await expect(smsCaptureId('user', MESSAGE_KEY)).resolves.toBe(
      await smsCaptureId('user', MESSAGE_KEY),
    );
  });

  it('keeps the same bank message separate for the user, rider, traveller and financer', async () => {
    const ids = await Promise.all(
      ['user', 'rider', 'traveller', 'financer'].map((ownerId) =>
        smsCaptureId(ownerId, MESSAGE_KEY),
      ),
    );

    expect(new Set(ids).size).toBe(4);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });

  it('keeps two bank messages separate for the same user', async () => {
    await expect(smsCaptureId('user', 'ref:998877665544')).resolves.not.toBe(
      await smsCaptureId('user', MESSAGE_KEY),
    );
  });
});
