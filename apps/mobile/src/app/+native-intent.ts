/**
 * Rewrite incoming native deep links before expo-router tries to match them.
 *
 * The one link that needs rewriting is the OAuth callback. Google and Apple
 * sign-in redirect to `baaki://auth#access_token=…` — see
 * `makeRedirectUri({ scheme: 'baaki', path: 'auth' })` in `lib/auth.tsx`. The
 * token exchange is already done in-process: `WebBrowser.openAuthSessionAsync`
 * hands that URL straight back to the caller, which calls `setSession`. So by
 * the time the OS *also* delivers the link as an app intent, it carries nothing
 * left to do — and there is no `/auth` screen, so letting the router match it
 * lands on "Unmatched Route — page could not be found" right after a successful
 * Google login. Send it to the root instead, where the session (now set)
 * decides between the tabs and the sign-in screen.
 *
 * This runs outside the app context, so it cannot read auth state — it only
 * rewrites the path. It must never throw: a crash here would take the cold
 * launch down with it, so anything unexpected passes straight through.
 *
 * @param path the incoming link. Named `path` but it is the full URL (e.g.
 *   `baaki://auth#…`), not just the path portion.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    // A base is required for the custom-scheme URL to parse. `baaki://auth`
    // lands `auth` in the hostname; a `baaki:///auth` triple-slash form lands it
    // in the pathname instead — cover both.
    const url = new URL(path, 'baaki://app');
    const firstSegment = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (url.hostname === 'auth' || firstSegment === 'auth') {
      return '/';
    }
    return path;
  } catch {
    return path;
  }
}
