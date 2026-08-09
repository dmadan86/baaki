import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { confirmUserEmail, listUsers, upgradeUser, type AdminUserListRow } from '@/lib/data';

export const dynamic = 'force-dynamic';

const PAGE = 25;

function when(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

function kind(u: AdminUserListRow): { label: string; cls: string } {
  if (u.is_anonymous) return { label: 'guest', cls: 'tag' };
  if (u.is_plus) return { label: 'plus', cls: 'tag tag-deletion' };
  return { label: 'free', cls: 'tag tag-idea' };
}

/** Carry the current filter + page through an action's redirect. */
function backTo(name: string, country: string, offset: number): string {
  const p = new URLSearchParams();
  if (name) p.set('name', name);
  if (country) p.set('country', country);
  if (offset) p.set('offset', String(offset));
  const qs = p.toString();
  return qs ? `/users?${qs}` : '/users';
}

export default async function Users({
  searchParams,
}: {
  searchParams: Promise<{
    name?: string;
    country?: string;
    offset?: string;
    error?: string;
    done?: string;
  }>;
}) {
  const sp = await searchParams;
  const name = (sp.name ?? '').trim();
  const country = (sp.country ?? '').trim();
  const offset = Math.max(0, Number(sp.offset ?? 0) || 0);

  const { total, rows } = await listUsers({ limit: PAGE, offset, namePrefix: name, country });
  const back = backTo(name, country, offset);

  async function filter(formData: FormData) {
    'use server';
    const p = new URLSearchParams();
    const n = String(formData.get('name') ?? '').trim();
    const c = String(formData.get('country') ?? '')
      .trim()
      .toUpperCase();
    if (n) p.set('name', n);
    if (c) p.set('country', c);
    const qs = p.toString();
    redirect(qs ? `/users?${qs}` : '/users');
  }

  async function confirm(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');
    const to = String(formData.get('back') ?? '/users');
    let failure: string | null = null;
    try {
      await confirmUserEmail(id);
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    const sep = to.includes('?') ? '&' : '?';
    if (failure) redirect(`${to}${sep}error=${encodeURIComponent(failure)}`);
    revalidatePath('/users');
    redirect(`${to}${sep}done=${encodeURIComponent('Email confirmed.')}`);
  }

  async function upgrade(formData: FormData) {
    'use server';
    const id = String(formData.get('id') ?? '');
    const days = Number(formData.get('days') ?? 365);
    const to = String(formData.get('back') ?? '/users');
    let message: string | null = null;
    let failure: string | null = null;
    try {
      message = await upgradeUser(id, days);
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    const sep = to.includes('?') ? '&' : '?';
    if (failure) redirect(`${to}${sep}error=${encodeURIComponent(failure)}`);
    revalidatePath('/users');
    redirect(`${to}${sep}done=${encodeURIComponent(message ?? 'Upgraded.')}`);
  }

  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE, total);

  return (
    <main>
      <header className="top">
        <h1>Users</h1>
        <p className="faint">{total.toLocaleString('en-IN')} signups</p>
      </header>

      {sp.error ? <p className="error">{sp.error}</p> : null}
      {sp.done ? <p className="faint">{sp.done}</p> : null}

      <section>
        <form action={filter} className="flag">
          <label>
            <span>Name or email starts with</span>
            <input type="text" name="name" defaultValue={name} placeholder="asha" />
          </label>
          <label>
            <span>Country</span>
            <input
              type="text"
              name="country"
              defaultValue={country}
              placeholder="IN"
              maxLength={2}
            />
          </label>
          <button type="submit">Filter</button>
          {name || country ? (
            <a className="faint" href="/users" style={{ alignSelf: 'center' }}>
              Clear
            </a>
          ) : null}
        </form>
        <p className="note">
          Sorted newest first. Type, devices and app version come from the account, its subscription
          and the devices it has registered — device columns fill in once the device-session feature
          is live on this project.
        </p>
      </section>

      <section className="scroll" style={{ marginTop: 12 }}>
        {rows.length === 0 ? (
          <p className="note">No signups match this filter.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Type</th>
                <th>Country</th>
                <th>Devices</th>
                <th>App</th>
                <th>Joined</th>
                <th>Last seen</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((u) => {
                const k = kind(u);
                return (
                  <tr key={u.id}>
                    <td style={{ textAlign: 'left', maxWidth: 260 }}>
                      <div style={{ fontWeight: 600 }}>{u.display_name ?? '—'}</div>
                      <div className="faint" style={{ fontSize: 12 }}>
                        {u.email ?? u.phone ?? '(no contact)'}
                        {u.email && !u.email_confirmed ? ' · unconfirmed' : ''}
                      </div>
                    </td>
                    <td>
                      <span className={k.cls}>{k.label}</span>
                    </td>
                    <td>{u.country_code ?? <span className="muted">—</span>}</td>
                    <td>
                      {u.device_count > 0 ? u.device_count : <span className="muted">0</span>}
                    </td>
                    <td>
                      {u.app_version ? (
                        <span>
                          {u.app_version}
                          {u.platform ? <span className="faint"> · {u.platform}</span> : null}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td>{when(u.created_at)}</td>
                    <td>{when(u.last_sign_in_at)}</td>
                    <td>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        {u.email_confirmed || !u.email ? null : (
                          <form action={confirm}>
                            <input type="hidden" name="id" value={u.id} />
                            <input type="hidden" name="back" value={back} />
                            <button type="submit" title="Confirm this email by hand">
                              Confirm
                            </button>
                          </form>
                        )}
                        <form
                          action={upgrade}
                          style={{ display: 'flex', gap: 4, alignItems: 'center' }}
                        >
                          <input type="hidden" name="id" value={u.id} />
                          <input type="hidden" name="back" value={back} />
                          <input
                            type="number"
                            name="days"
                            min={1}
                            max={3650}
                            defaultValue={365}
                            aria-label="Days"
                            style={{ width: 64 }}
                          />
                          <button type="submit" title="Comp a paid grant">
                            Upgrade
                          </button>
                        </form>
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>

      <div className="row" style={{ justifyContent: 'space-between', marginTop: 14 }}>
        <span className="faint">
          {from}–{to} of {total.toLocaleString('en-IN')}
        </span>
        <span className="row" style={{ gap: 8 }}>
          {offset > 0 ? (
            <a href={backTo(name, country, Math.max(0, offset - PAGE))}>← Previous</a>
          ) : (
            <span className="muted">← Previous</span>
          )}
          {offset + PAGE < total ? (
            <a href={backTo(name, country, offset + PAGE)}>Next →</a>
          ) : (
            <span className="muted">Next →</span>
          )}
        </span>
      </div>
    </main>
  );
}
