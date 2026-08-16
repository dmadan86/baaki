import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

import { checkPassword, issueToken } from '@/lib/session';

export default async function Login({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const { error } = await searchParams;

  async function signIn(formData: FormData) {
    'use server';

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
        {error ? <p className="error">That did not work.</p> : null}
      </form>
    </main>
  );
}
