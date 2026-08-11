import { test, expect } from '@playwright/test';

/**
 * The app should be responsive: the sign-in card stays usable and, crucially,
 * nothing pushes the page wider than the viewport at a phone width — a sideways
 * scrollbar on a 360px screen is the failure this guards.
 */
const VIEWPORTS = [
  { name: 'phone', width: 360, height: 740 },
  { name: 'tablet', width: 820, height: 1180 },
  { name: 'desktop', width: 1280, height: 800 },
] as const;

for (const vp of VIEWPORTS) {
  test(`no horizontal overflow at ${vp.name} (${vp.width}px)`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await page.goto('/');

    await expect(page.getByRole('button', { name: /google/i })).toBeVisible();

    const overflows = await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflows, 'page must not scroll horizontally').toBe(false);
  });
}
