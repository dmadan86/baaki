import { test, expect } from '@playwright/test';

/**
 * The language and text direction are decided on the server from
 * Accept-Language (layout.tsx), so `<html lang>` / `<html dir>` are right in the
 * first paint rather than corrected after hydration. An Arabic reader should
 * find the page already the right way round.
 */
test.describe('language from Accept-Language', () => {
  test('English by default — left to right', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en');
    await expect(page.locator('html')).toHaveAttribute('dir', 'ltr');
  });

  test.describe('Arabic', () => {
    test.use({ locale: 'ar', extraHTTPHeaders: { 'Accept-Language': 'ar' } });

    test('renders right to left, with the Arabic sign-in copy', async ({ page }) => {
      await page.goto('/');
      await expect(page.locator('html')).toHaveAttribute('lang', 'ar');
      await expect(page.locator('html')).toHaveAttribute('dir', 'rtl');
      await expect(page.getByRole('button', { name: /المتابعة عبر Google/ })).toBeVisible();
    });
  });
});
