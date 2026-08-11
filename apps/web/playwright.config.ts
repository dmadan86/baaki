import { defineConfig, devices } from '@playwright/test';

/**
 * End-to-end tests for the web client — the app as a browser meets it.
 *
 * These drive the *unauthenticated* surface (the sign-in front door, the
 * language/direction the server picks from Accept-Language, and that nothing
 * overflows a phone). That is the part with no live backend behind it: a real
 * session's data lives under RLS in a Supabase project, and exercising it is a
 * heavier suite that needs test credentials — the mobile app's live Maestro
 * flows are the model for that, and it is deliberately out of scope here.
 *
 * The dev server is booted with placeholder Supabase env: the client is
 * constructed (it throws at import without them) but the pages under test never
 * make a network call, so no real project is touched.
 */

const PORT = 4020;
const baseURL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: `pnpm exec next dev --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    env: {
      // Not a real project — the sign-in surface never calls it.
      NEXT_PUBLIC_SUPABASE_URL: 'https://example.supabase.co',
      NEXT_PUBLIC_SUPABASE_ANON_KEY: 'e2e-anon-key-not-real',
    },
  },
});
