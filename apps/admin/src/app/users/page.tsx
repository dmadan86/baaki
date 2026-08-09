import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { Nav } from '@/components/Nav';
import { confirmUserEmail, searchUsers, upgradeUser, type AdminUserRow } from '@/lib/data';

export const dynamic = 'force-dynamic';

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

export default async function Users({
  searchParams,
}: {
  searchParams: Promise<{ q?: string; error?: string; done?: string }>;
}) {
  const { q, error, done } = await searchParams;
  const query = (q ?? '').trim();
  const results: AdminUserRow[] = query ? await searchUsers(query) : [];

  async function search(formData: FormData) {
    'use server';
    const next = String(formData.get('q') ?? '').trim();
    redirect(next ? `/users?q=${encodeURIComponent(next)}` : '/users');
  }

  async function confirm(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');
    const back = String(formData.get('q') ?? '');
    let failure: string | null = null;
    try {
      await confirmUserEmail(id);
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    const base = `/users?q=${encodeURIComponent(back)}`;
    if (failure) redirect(`${base}&error=${encodeURIComponent(failure)}`);
    revalidatePath('/users');
    redirect(`${base}&done=${encodeURIComponent('Email confirmed.')}`);
  }

  async function upgrade(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');
    const days = Number(formData.get('days') ?? 365);
    const back = String(formData.get('q') ?? '');
    let message: string | null = null;
    let failure: string | null = null;
    try {
      message = await upgradeUser(id, days);
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    const base = `/users?q=${encodeURIComponent(back)}`;
    if (failure) redirect(`${base}&error=${encodeURIComponent(failure)}`);
    revalidatePath('/users');
    redirect(`${base}&done=${encodeURIComponent(message ?? 'Upgraded.')}`);
  }

  return (
    <main>
      <header className="top">
        <h1>Users</h1>
        <Nav here="users" />
      </header>

      {error ? <p className="error">{error}</p> : null}
      {done ? <p className="faint">{done}</p> : null}

      <section>
        <form action={search} className="flag">
          <label>
            <span>Search by email, phone or id</span>
            <input type="text" name="q" defaultValue={query} placeholder="asha@example.com" />
          </label>
          <button type="submit">Search</button>
        </form>
        <p className="note">
          There is no server-side search in the auth directory, so this walks the first pages and
          matches here — enough for support, not a report. Names come from <code>profiles</code>.
        </p>
      </section>

      {query && results.length === 0 ? (
        <p className="note">Nobody matched &ldquo;{query}&rdquo;.</p>
      ) : null}

      {results.map((u) => (
        <section key={u.id}>
          <h2 style={{ marginBottom: 4 }}>{u.display_name ?? u.email ?? u.id}</h2>
          <p className="faint" style={{ marginTop: 0 }}>
            {u.email ?? u.phone ?? '(no contact)'} · {u.is_anonymous ? 'guest' : 'account'} ·{' '}
            {u.email_confirmed ? 'email confirmed' : 'email NOT confirmed'} · joined{' '}
            {when(u.created_at)}
          </p>
          <p className="faint" style={{ marginTop: 0, fontSize: 12 }}>
            <code>{u.id}</code>
          </p>

          <div className="scroll" style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
            {u.email_confirmed ? null : (
              <form action={confirm} className="flag">
                <input type="hidden" name="id" value={u.id} />
                <input type="hidden" name="q" value={query} />
                <button type="submit">Confirm email</button>
              </form>
            )}
            <form action={upgrade} className="flag">
              <input type="hidden" name="id" value={u.id} />
              <input type="hidden" name="q" value={query} />
              <label>
                <span>Upgrade — days</span>
                <input type="number" name="days" min={1} max={3650} defaultValue={365} />
              </label>
              <button type="submit">Upgrade to paid</button>
            </form>
          </div>
        </section>
      ))}
    </main>
  );
}
