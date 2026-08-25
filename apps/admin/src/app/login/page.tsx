import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';

import { checkPassword, issueToken } from '@/lib/session';
import { clientAddress, recordLoginAttempt } from '@/lib/loginThrottle';
import { assertSameOrigin, RequestRejected } from '@/lib/csrf';

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function signIn(formData: FormData) {
    'use server';

    // Reject a cross-site POST at the login form too — a forged login is a way
    // to fixate a session on somebody. There is no session-bound token yet, so
    // this leans on the Origin check alone.
    try {
      await assertSameOrigin();
    } catch (caught) {
      if (caught instanceof RequestRejected) redirect('/login?error=1');
      throw caught;
    }

    // Throttle next, on the address, so a locked source cannot even test a
    // guess. Counts this attempt whether or not the password is right — the
    // operator logs in a handful of times a day and never meets the limit.
    const address = clientAddress((await headers()).get('x-forwarded-for'));
    const gate = await recordLoginAttempt(address);
    if (!gate.allowed) {
      redirect('/login?error=locked');
    }

    const password = String(formData.get('password') ?? '');
    if (!(await checkPassword(password))) {
      // No detail, and the same wording whatever went wrong. There is one
      // account here; telling a stranger anything about why they failed only
      // helps them.
      redirect('/login?error=1');
    }

    const token = await issueToken();
    (await cookies()).set(token.name, token.value, {
      httpOnly: true,
      sameSite: 'lax',
      // Off on localhost, on everywhere else — a Secure cookie is never sent
      // over the plain-HTTP dev server, which would lock you out of your own
      // machine.
      secure: process.env.NODE_ENV === 'production',
      path: '/',
      maxAge: token.maxAge,
    });
    redirect('/');
  }

  return (
    <main className="login">
      <h1>Baaki admin</h1>
      <p className="faint">Private console. Contains personal data.</p>
      <form action={signIn}>
        <input
          type="password"
          name="password"
          placeholder="Password"
          aria-label="Password"
          autoFocus
          autoComplete="current-password"
        />
        <button type="submit">Sign in</button>
        {error === 'locked' ? (
          <p className="error">Too many attempts. Wait a few minutes and try again.</p>
        ) : error ? (
          <p className="error">That did not work.</p>
        ) : null}
      </form>
    </main>
  );
}
