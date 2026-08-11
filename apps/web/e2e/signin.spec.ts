import { test, expect } from '@playwright/test';

/**
 * The front door. With no session, `/` routes to the sign-in card (AppFrame),
 * which offers both providers ADR-006 names — Google and a passwordless email
 * link — plus the note that an invite link is the guest way in.
 */
test.describe('sign-in (the unauthenticated front door)', () => {
  test('offers Google and the email magic link', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
    await expect(page.getByPlaceholder('you@email.com')).toBeVisible();
    await expect(page.getByRole('button', { name: /email me a sign-in link/i })).toBeVisible();
    // The guest path is signposted, not hidden.
    await expect(page.getByText(/open an invite link/i)).toBeVisible();
  });

  test('catches a malformed email before any round trip', async ({ page }) => {
    await page.goto('/');

    // Passes the browser's native type=email check (has an @) but not the app's
    // own regex (no dot), so the client-side guard is what fires — no network.
    await page.getByPlaceholder('you@email.com').fill('foo@bar');
    await page.getByRole('button', { name: /email me a sign-in link/i }).click();

    await expect(page.getByText(/does not look like an email/i)).toBeVisible();
    // Still on the sign-in screen; nothing navigated or was sent.
    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  });
});
