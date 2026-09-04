/**
 * Rewrite incoming native deep links before expo-router tries to match them.
 *
 * The one link that needs rewriting is the OAuth callback. Google and Apple
 * sign-in redirect to `waves://auth?code=…` — see
 * `makeRedirectUri({ scheme: 'waves', path: 'auth' })` in `lib/auth.tsx`. The
 * code exchange is already done in-process: `WebBrowser.openAuthSessionAsync`
 * hands that URL straight back to the caller, which calls
 * `exchangeCodeForSession` (a one-time code; a second delivery is worthless). So
 * by the time the OS *also* delivers the link as an app intent, it carries
 * nothing left to do — and there is no `/auth` screen, so letting the router match it
 * lands on "Unmatched Route — page could not be found" right after a successful
 * Google login. Send it to the root instead, where the session (now set)
 * decides between the tabs and the sign-in screen.
 *
 * This runs outside the app context, so it cannot read auth state — it only
 * rewrites the path. It must never throw: a crash here would take the cold
 * launch down with it, so anything unexpected passes straight through.
 *
 * @param path the incoming link. Named `path` but it is the full URL (e.g.
 *   `waves://auth#…`), not just the path portion.
 */
export function redirectSystemPath({ path }: { path: string; initial: boolean }): string {
  try {
    // A base is required for the custom-scheme URL to parse. `waves://auth`
    // lands `auth` in the hostname; a `waves:///auth` triple-slash form lands it
    // in the pathname instead — cover both. The base only matters when `path`
    // arrives schemeless; a full `waves://` URL parses on its own.
    const url = new URL(path, 'waves://app');
    const firstSegment = url.pathname.replace(/^\/+/, '').split('/')[0];
    if (url.hostname === 'auth' || firstSegment === 'auth') {
      return '/';
    }
    // The Drive-backup consent redirects to `waves://oauthredirect`, and the
    // same double delivery happens: `promptAsync` has already taken the code
    // and swapped it, so the intent carries nothing left to do — but there is
    // no `/oauthredirect` screen either, and letting the router match it lands
    // on "Unmatched Route" the moment somebody links their Drive. Unlike
    // sign-in, sending this one to the root would be wrong: the person is
    // standing on the backup screen and expects to still be there, so it goes
    // back to the screen that started the flow. A `navigate` to a route already
    // in the stack returns to it rather than pushing a second copy.
    if (url.hostname === 'oauthredirect' || firstSegment === 'oauthredirect') {
      return '/settings/backup';
    }
    // The scan-receipt home-screen widget carries a fixed `?scan=1` — its link
    // is baked at build time and cannot mint a fresh value per tap. The capture
    // screen's consume-once guard keys off the nonce *value*, so a constant one
    // fires the scanner only on the first tap of a warm process and silently
    // drops to the plain form thereafter. Rewriting to a fresh `Date.now()`
    // here — the boundary every incoming link crosses, cold or warm — gives
    // each tap a unique nonce while still letting the guard swallow the
    // duplicate Android delivers when it returns from the native camera.
    if (
      (url.hostname === 'capture' || firstSegment === 'capture') &&
      url.searchParams.has('scan')
    ) {
      return `/capture?scan=${Date.now()}`;
    }
    return path;
  } catch {
    return path;
  }
}
