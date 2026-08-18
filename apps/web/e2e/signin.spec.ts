import { test, expect } from '@playwright/test';

/**
 * The front door. With no session, `/` routes to the sign-in card (AppFrame),
 * which offers the three ways in ADR-006 names — Google, an email-and-password
 * account, and a passwordless email link — plus the note that an invite link is
 * the guest way in.
 *
 * These tests only exercise the *client-side* guards, which fire before any
 * network call (a bad email, a too-short password). A real sign-in reaches
 * Supabase and is out of scope here — the placeholder env has no project behind
 * it.
 */
test.describe('sign-in (the unauthenticated front door)', () => {
  test('offers Google, password, and the email magic link', async ({ page }) => {
    await page.goto('/');

    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
    await expect(page.getByPlaceholder('you@email.com')).toBeVisible();
    await expect(page.getByPlaceholder('Password')).toBeVisible();
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /email me a sign-in link/i })).toBeVisible();
    // The guest path is signposted, not hidden.
    await expect(page.getByText(/open an invite link/i)).toBeVisible();
  });

  test('toggles between signing in and creating an account', async ({ page }) => {
    await page.goto('/');

    // Sign-in is the default; the toggle offers to make a new account instead.
    await expect(page.getByRole('button', { name: /^sign in$/i })).toBeVisible();
    await page.getByRole('button', { name: /new here\? create an account/i }).click();

    // Now the primary action is create-account, and the toggle flips back.
    await expect(page.getByRole('button', { name: /^create account$/i })).toBeVisible();
    await expect(
      page.getByRole('button', { name: /already have an account\? sign in/i }),
    ).toBeVisible();
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

  test('rejects a too-short password before any round trip', async ({ page }) => {
    await page.goto('/');

    // Valid email, but the password fails @waves/core's length rule, which
    // throws before the client reaches Supabase — the guard is local.
    await page.getByPlaceholder('you@email.com').fill('you@email.com');
    await page.getByPlaceholder('Password').fill('short');
    await page.getByRole('button', { name: /^sign in$/i }).click();

    await expect(page.getByText(/at least 8 characters/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /continue with google/i })).toBeVisible();
  });
});
