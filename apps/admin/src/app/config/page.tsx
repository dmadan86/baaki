import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { appConfig, saveAppConfig } from '@/lib/data';

export const dynamic = 'force-dynamic';

/**
 * The numeric knobs. Today that is the per-group receipt cap; anything else that
 * needs a number the console can turn without a deploy joins the same table and
 * shows up here as another row.
 */
export default async function Config({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const rows = await appConfig();

  async function save(formData: FormData) {
    'use server';

    let failure: string | null = null;
    try {
      const rawValue = String(formData.get('value') ?? '').trim();
      if (rawValue === '') {
        throw new Error('A limit is a whole number, zero or more.');
      }
      await saveAppConfig({
        key: String(formData.get('key') ?? '').trim(),
        value: Number(rawValue),
      });
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }

    if (failure) redirect(`/config?error=${encodeURIComponent(failure)}`);
    revalidatePath('/config');
    redirect('/config?saved=1');
  }

  return (
    <main>
      <header className="top">
        <h1>Limits</h1>{' '}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {saved ? <p className="faint">Saved.</p> : null}

      <p className="note" style={{ padding: 0 }}>
        Numeric knobs the app reads at runtime. The receipt cap is how many receipts a group may
        hold before it must upgrade or add storage — a paid group has no cap. The number lives here
        so it can change without a deploy; the database enforces it, so lowering it is real.
      </p>

      {rows.length === 0 ? (
        <section style={{ marginTop: 20 }}>
          <p className="note">
            No knobs yet. If you expected some, the
            <code> 20260818160000_receipt_cap </code> migration may not be deployed to this project.
          </p>
        </section>
      ) : null}

      {rows.map((row) => (
        <div key={row.key}>
          <h2>{row.key}</h2>
          <section>
            <form action={save} className="flag">
              <input type="hidden" name="key" value={row.key} />
              {row.description ? <p className="note">{row.description}</p> : null}
              <label>
                <span>Value</span>
                <input
                  type="number"
                  name="value"
                  min={0}
                  step={1}
                  defaultValue={row.value}
                  required
                />
              </label>
              <button type="submit">Save</button>
            </form>
          </section>
        </div>
      ))}
    </main>
  );
}
