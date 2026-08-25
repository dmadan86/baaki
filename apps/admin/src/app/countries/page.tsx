import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { COUNTRIES, countryFlag, dialingCodeForCountry } from '@waves/core';

import { countrySettings, saveCountrySettings } from '@/lib/data';
import { guardMutation } from '@/lib/csrf';
import { CsrfField } from '@/components/CsrfField';

export const dynamic = 'force-dynamic';

/**
 * The countries the phone-number sign-in offers. The app ships a fixed market
 * set; this turns which of them the dial-code picker actually shows, without a
 * deploy. Denylist — everything is on unless it is unticked here — so a fresh
 * project offers every market and nothing has to be switched on to work.
 */
const DIALABLE = COUNTRIES.filter((country) => dialingCodeForCountry(country.code));

export default async function Countries({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const rows = await countrySettings();
  const disabled = new Set(rows.filter((row) => !row.enabled).map((row) => row.code));
  const enabledCount = DIALABLE.length - disabled.size;

  async function save(formData: FormData) {
    'use server';

    let failure: string | null = null;
    try {
      await guardMutation(formData);
      // An unticked box submits nothing, so its absence is "off". Every country
      // is written, so the table always mirrors the console's last full choice.
      await saveCountrySettings(
        DIALABLE.map((country) => ({
          code: country.code,
          enabled: formData.get(country.code) === 'on',
        })),
      );
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }

    if (failure) redirect(`/countries?error=${encodeURIComponent(failure)}`);
    revalidatePath('/countries');
    redirect('/countries?saved=1');
  }

  return (
    <main>
      <header className="top">
        <h1>Countries</h1>{' '}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {saved ? <p className="faint">Saved.</p> : null}

      <p className="note" style={{ padding: 0 }}>
        Which countries the phone sign-in offers. Untick one to hide it from the dial-code picker —
        a market we are not live in, or one we have paused. A country with no setting is offered, so
        an empty list shows everything. {enabledCount} of {DIALABLE.length} on.
      </p>

      <section style={{ marginTop: 20 }}>
        <form action={save} className="flag">
          <CsrfField />
          <div className="country-grid">
            {DIALABLE.map((country) => (
              <label key={country.code} className="country-row">
                <input
                  type="checkbox"
                  name={country.code}
                  defaultChecked={!disabled.has(country.code)}
                />
                <span>
                  {countryFlag(country.code)} {country.name}{' '}
                  <span className="faint">{dialingCodeForCountry(country.code)}</span>
                </span>
              </label>
            ))}
          </div>
          <button type="submit">Save</button>
        </form>
      </section>
    </main>
  );
}
