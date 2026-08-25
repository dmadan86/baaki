import { NextResponse, type NextRequest } from 'next/server';

import {
  hasTrustedOrigin,
  isValidToken,
  ORIGIN_SECRET_HEADER,
  SESSION_COOKIE,
} from '@/lib/session';

/**
 * The gate, in front of everything.
 *
 * `proxy` rather than `middleware`: Next 16 deprecated that filename and warns
 * on every build. Same function, same config, new name.
 *
 * Here rather than as a check inside each page, because the failure mode of
 * per-page checks is a page somebody forgot to add one to — and here that page
 * would be serving the whole business to the internet. `requireSession()` in
 * the data layer repeats the check anyway: this is the door, that is the lock
 * on the cabinet. That belt-and-braces already earned itself once — this file
 * sat at the project root instead of in `src/`, where Next silently does not
 * load it, and only the second check stopped the requests.
 *
 * Two checks, in order:
 *
 * 1. **The trusted-origin secret.** Every request — the login screen included —
 *    must carry the header Cloudflare Access injects. A valid session cookie is
 *    not enough on its own, because the `*.vercel.app` origin is reachable
 *    directly and the custom domain is not covered by Vercel's own protection;
 *    without this a stolen or forged cookie walks straight in around Cloudflare.
 *    Refused with a bare 403 that says nothing about what is behind it.
 * 2. **The session cookie**, for everything except `/login` itself.
 *
 * Note this may run on a CDN edge separately from the render, so it holds no
 * state and shares nothing with the pages beyond the cookie it validates.
 */
export async function proxy(request: NextRequest) {
  // The second door first: a request that did not come through the trusted
  // proxy has no business reaching even the login form.
  if (!(await hasTrustedOrigin(request.headers.get(ORIGIN_SECRET_HEADER)))) {
    return new NextResponse(null, { status: 403 });
  }

  // The login screen is reachable without a session (that is where you get
  // one) — but only now that the origin gate above has already let it through.
  if (request.nextUrl.pathname === '/login') {
    return NextResponse.next();
  }

  if (await isValidToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  /**
   * Everything except Next's own static assets. `/login` is deliberately *not*
   * excluded here any more: it still skips the cookie check inside `proxy`, but
   * it must pass through the origin-secret gate like every other route, or the
   * password form stays reachable on the open `*.vercel.app` back door. Written
   * as an exclusion so a route added later is protected by default — the
   * opposite ordering is how a new page ships unguarded.
   */
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
