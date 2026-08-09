import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createPromoCode, grantPromo, promoCodes } from '@/lib/data';

export const dynamic = 'force-dynamic';

const num = (value: number | string) => Number(value).toLocaleString('en-IN');
const day = (value: string | null) => (value ? new Date(value).toLocaleDateString('en-IN') : '—');

export default async function Promotions({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { error, done } = await searchParams;
  const codes = await promoCodes();

  async function create(formData: FormData) {
    'use server';

    let failure: string | null = null;
    try {
      await createPromoCode({
        code: String(formData.get('code') ?? ''),
        days: Number(formData.get('days') ?? 30),
        maxRedemptions: Number(formData.get('max') ?? 1),
        note: String(formData.get('note') ?? '').trim(),
      });
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }

    if (failure) redirect(`/promotions?error=${encodeURIComponent(failure)}`);
    revalidatePath('/promotions');
    redirect('/promotions?done=Code+created');
  }

  async function grant(formData: FormData) {
    'use server';

    let failure: string | null = null;
    let message = '';
    try {
      message = await grantPromo(
        String(formData.get('profile') ?? ''),
        Number(formData.get('days') ?? 30),
      );
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }

    if (failure) redirect(`/promotions?error=${encodeURIComponent(failure)}`);
    revalidatePath('/promotions');
    redirect(`/promotions?done=${encodeURIComponent(message)}`);
  }

  return (
    <main>
      <header className="top">
        <h1>Promotions</h1>{' '}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {done ? <p className="faint">{done}</p> : null}

      <p className="note" style={{ padding: 0 }}>
        A promotion is an ordinary <code>subscriptions</code> row with{' '}
        <code>store = &lsquo;promo&rsquo;</code>. Every screen that already asks what plan somebody
        is on gets the right answer with no change — there is no second source of truth for who has
        paid.
      </p>

      <h2>Comp an account</h2>
      <section>
        <form action={grant} className="flag">
          <label>
            <span>Profile id</span>
            <input type="text" name="profile" placeholder="uuid" required size={38} />
          </label>
          <label>
            <span>Days</span>
            <input type="number" name="days" min={1} max={3650} defaultValue={30} />
          </label>
          <button type="submit">Grant Plus</button>
        </form>
        <p className="note">
          Keyed on the account and the day, so pressing this twice in one conversation is the same
          grant rather than two months.
        </p>
      </section>

      <h2>Codes</h2>
      <section className="scroll">
        {codes.length === 0 ? (
          <p className="note">
            None yet. If you expected some, the <code>20260808210000_promotions</code> migration may
            not be deployed to this project.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Code</th>
                <th>Grants</th>
                <th>Used</th>
                <th>Of</th>
                <th>Expires</th>
                <th>Note</th>
              </tr>
            </thead>
            <tbody>
              {codes.map((row) => (
                <tr key={row.code}>
                  <td>
                    <code>{row.code}</code>
                  </td>
                  <td>{num(row.days)} days</td>
                  <td>{num(row.redeemed_count)}</td>
                  <td>{num(row.max_redemptions)}</td>
                  <td>{day(row.expires_at)}</td>
                  <td style={{ textAlign: 'left' }}>
                    {row.note || <span className="muted">—</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <h2>New code</h2>
      <section>
        <form action={create} className="flag">
          <label>
            <span>Code</span>
            <input type="text" name="code" placeholder="DIWALI25" required />
          </label>
          <label>
            <span>Days granted</span>
            <input type="number" name="days" min={1} max={3650} defaultValue={30} />
          </label>
          <label>
            <span>Max redemptions</span>
            <input type="number" name="max" min={1} defaultValue={100} />
          </label>
          <label>
            <span>Note</span>
            <input type="text" name="note" placeholder="Diwali campaign" />
          </label>
          <button type="submit">Create code</button>
        </form>
        <p className="note">
          Uppercase letters and digits only — these get read aloud and typed by hand. Redeeming is
          one code per account, enforced by the same unique key the app stores use to stop a
          replayed store webhook granting a purchase twice.
        </p>
      </section>
    </main>
  );
}
