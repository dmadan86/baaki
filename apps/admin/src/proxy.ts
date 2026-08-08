import { NextResponse, type NextRequest } from 'next/server';

import { isValidToken, SESSION_COOKIE } from '@/lib/session';

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
 * Note this may run on a CDN edge separately from the render, so it holds no
 * state and shares nothing with the pages beyond the cookie it validates.
 */
export async function proxy(request: NextRequest) {
  if (await isValidToken(request.cookies.get(SESSION_COOKIE)?.value)) {
    return NextResponse.next();
  }

  return NextResponse.redirect(new URL('/login', request.url));
}

export const config = {
  /**
   * Everything except the login screen itself and Next's own assets. Written as
   * an exclusion so a route added later is protected by default — the opposite
   * ordering is how a new page ships unguarded.
   */
  matcher: ['/((?!login|_next/static|_next/image|favicon.ico).*)'],
};
