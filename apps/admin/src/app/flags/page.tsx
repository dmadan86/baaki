import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { flagResults, flags, saveFlag, type FlagResultRow } from '@/lib/data';

export const dynamic = 'force-dynamic';

const num = (value: number | string) => Number(value).toLocaleString('en-IN');

export default async function Flags({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const all = await flags();

  // Results only for the flags actually running. Bucketing every profile is a
  // full scan of `profiles` per flag, and doing it for switches nobody has
  // turned on is work with no reader.
  const running = all.filter((flag) => flag.enabled);
  const results = new Map<string, FlagResultRow[]>(
    await Promise.all(
      running.map(async (flag) => [flag.key, await flagResults(flag.key)] as const),
    ),
  );

  async function save(formData: FormData) {
    'use server';

    const variants = String(formData.get('variants') ?? '')
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean);

    // Collected rather than rethrown, because `redirect` works by throwing and
    // a catch around it would swallow the navigation.
    let failure: string | null = null;
    try {
      await saveFlag({
        key: String(formData.get('key') ?? '').trim(),
        description: String(formData.get('description') ?? '').trim(),
        enabled: formData.get('enabled') === 'on',
        rolloutPercent: Number(formData.get('rollout') ?? 0),
        variants,
      });
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }

    if (failure) redirect(`/flags?error=${encodeURIComponent(failure)}`);
    revalidatePath('/flags');
    redirect('/flags?saved=1');
  }

  return (
    <main>
      <header className="top">
        <h1>Experiments</h1>{' '}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {saved ? <p className="faint">Saved.</p> : null}

      <p className="note" style={{ padding: 0 }}>
        Nobody&rsquo;s assignment is stored. A person&rsquo;s arm is hashed from the flag key and
        their profile id, by the same rule in the app and in the database, so the split needs no
        round trip and an experiment can be read retrospectively — including for the days before it
        occurred to anybody to look.
      </p>

      {all.length === 0 ? (
        <section style={{ marginTop: 20 }}>
          <p className="note">
            No flags yet. If you expected some, the
            <code> 20260808200000_feature_flags </code> migration may not be deployed to this
            project.
          </p>
        </section>
      ) : null}

      {all.map((flag) => {
        const rows = results.get(flag.key) ?? [];
        const enrolled = rows.reduce((sum, row) => sum + Number(row.people), 0);

        return (
          <div key={flag.key}>
            <h2>{flag.key}</h2>
            <section>
              <form action={save} className="flag">
                <input type="hidden" name="key" value={flag.key} />
                <label>
                  <span>Description</span>
                  <input type="text" name="description" defaultValue={flag.description} />
                </label>
                <label className="inline">
                  <input type="checkbox" name="enabled" defaultChecked={flag.enabled} />
                  <span>Enabled</span>
                </label>
                <label>
                  <span>Rollout %</span>
                  <input
                    type="number"
                    name="rollout"
                    min={0}
                    max={100}
                    defaultValue={flag.rollout_percent}
                  />
                </label>
                <label>
                  <span>Arms (comma separated)</span>
                  <input type="text" name="variants" defaultValue={flag.variants.join(', ')} />
                </label>
                <button type="submit">Save</button>
              </form>

              {flag.enabled ? (
                rows.length === 0 ? (
                  <p className="note">
                    Nobody is enrolled. At {flag.rollout_percent}% rollout that is expected if there
                    are few accounts.
                  </p>
                ) : (
                  <div className="scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>Arm</th>
                          <th>People</th>
                          <th>Share</th>
                          <th>Expenses created</th>
                          <th>Per person</th>
                          <th>Active 30d</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((row) => (
                          <tr key={row.variant}>
                            <td>{row.variant}</td>
                            <td>{num(row.people)}</td>
                            <td>
                              {enrolled === 0
                                ? '—'
                                : `${Math.round((Number(row.people) / enrolled) * 100)}%`}
                            </td>
                            <td>{num(row.expenses_created)}</td>
                            <td>
                              {Number(row.people) === 0
                                ? '—'
                                : (Number(row.expenses_created) / Number(row.people)).toFixed(2)}
                            </td>
                            <td>{num(row.active_30d)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <p className="note">
                      People outside the rollout are not shown. They are not a control group — the
                      experiment never touched them, and putting them beside the arms invites the
                      one comparison that is wrong.
                    </p>
                  </div>
                )
              ) : (
                <p className="note">Off. Everybody sees whatever the app did before this flag.</p>
              )}
            </section>
          </div>
        );
      })}

      <h2>New flag</h2>
      <section>
        <form action={save} className="flag">
          <label>
            <span>Key</span>
            <input type="text" name="key" placeholder="itemized_receipts" required />
          </label>
          <label>
            <span>Description</span>
            <input type="text" name="description" />
          </label>
          <label className="inline">
            <input type="checkbox" name="enabled" />
            <span>Enabled</span>
          </label>
          <label>
            <span>Rollout %</span>
            <input type="number" name="rollout" min={0} max={100} defaultValue={0} />
          </label>
          <label>
            <span>Arms (comma separated)</span>
            <input type="text" name="variants" defaultValue="control, treatment" />
          </label>
          <button type="submit">Create</button>
        </form>
      </section>
    </main>
  );
}
