/**
 * `removeRestrictedImage` (party-only buckets — settlement proofs, expense
 * attachments) is documented as best-effort: its one call site is a
 * housekeeping delete after a replace/removal, and the caller must not be
 * blown up by an `r2-sign` failure it cannot do anything about (offline,
 * expired session, the object already gone). The guard is a bare
 * `.catch(() => {})` around the `signCall`. This is the regression test for
 * that contract: it never shipped with one, so nothing caught it if a future
 * edit dropped the `.catch`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock('@/lib/backend', () => ({
  backend: { functions: { invoke: h.invoke } },
  backendConfigured: true,
}));

const { removeRestrictedImage } = await import('../src/lib/storage');

const ORIGINAL_R2_ENABLED = process.env.EXPO_PUBLIC_R2_ENABLED;

beforeEach(() => {
  h.invoke.mockReset();
  process.env.EXPO_PUBLIC_R2_ENABLED = 'true';
});

afterEach(() => {
  // Restore whatever the process started with, so a test that flips the flag
  // never leaks it into a later file.
  if (ORIGINAL_R2_ENABLED === undefined) delete process.env.EXPO_PUBLIC_R2_ENABLED;
  else process.env.EXPO_PUBLIC_R2_ENABLED = ORIGINAL_R2_ENABLED;
});

describe('removeRestrictedImage — best-effort delete', () => {
  it('does not throw when the r2-sign delete call rejects', async () => {
    h.invoke.mockRejectedValue(new Error('network unreachable'));

    await expect(
      removeRestrictedImage('expense-attachments', 'expense-1', 'expense-1/receipt.webp'),
    ).resolves.toBeUndefined();
    expect(h.invoke).toHaveBeenCalledWith(
      'r2-sign',
      expect.objectContaining({
        body: expect.objectContaining({
          action: 'delete',
          bucket: 'expense-attachments',
          subjectId: 'expense-1',
          path: 'expense-1/receipt.webp',
        }),
      }),
    );
  });

  it('does not throw when r2-sign returns an application error (data null, error set)', async () => {
    h.invoke.mockResolvedValue({ data: null, error: { message: 'NOT_A_PARTY' } });

    await expect(
      removeRestrictedImage('settlement-proofs', 'settlement-1', 'settlement-1/proof.webp'),
    ).resolves.toBeUndefined();
  });

  it('still calls through and resolves cleanly when the delete succeeds', async () => {
    h.invoke.mockResolvedValue({ data: {}, error: null });

    await expect(
      removeRestrictedImage('expense-attachments', 'expense-2', 'expense-2/photo.webp'),
    ).resolves.toBeUndefined();
    expect(h.invoke).toHaveBeenCalledTimes(1);
  });

  it('is a no-op — never calls r2-sign at all — when R2 is disabled', async () => {
    process.env.EXPO_PUBLIC_R2_ENABLED = 'false';

    await expect(
      removeRestrictedImage('expense-attachments', 'expense-3', 'expense-3/photo.webp'),
    ).resolves.toBeUndefined();
    expect(h.invoke).not.toHaveBeenCalled();
  });
});
