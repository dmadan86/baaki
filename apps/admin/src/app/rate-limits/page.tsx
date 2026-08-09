import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { Nav } from '@/components/Nav';
import {
  rateLimitEnabled,
  rateLimitRules,
  saveRateLimitRule,
  setRateLimitEnabled,
  type RateLimitRuleRow,
} from '@/lib/data';

export const dynamic = 'force-dynamic';

/** Seconds rendered as the unit an operator thinks in. */
function window(seconds: number): string {
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  if (seconds % 60 === 0) return `${seconds / 60}m`;
  return `${seconds}s`;
}

export default async function RateLimits({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; saved?: string }>;
}) {
  const { error, saved } = await searchParams;
  const [enabled, rules] = await Promise.all([rateLimitEnabled(), rateLimitRules()]);

  async function toggleMaster(formData: FormData) {
    'use server';
    let failure: string | null = null;
    try {
      await setRateLimitEnabled(formData.get('enabled') === 'on');
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    if (failure) redirect(`/rate-limits?error=${encodeURIComponent(failure)}`);
    revalidatePath('/rate-limits');
    redirect('/rate-limits?saved=1');
  }

  async function saveRule(formData: FormData) {
    'use server';
    let failure: string | null = null;
    try {
      await saveRateLimitRule({
        bucket: String(formData.get('bucket') ?? '').trim(),
        enabled: formData.get('enabled') === 'on',
        maxCalls: Number(formData.get('max_calls') ?? 0),
        windowSeconds: Number(formData.get('window_seconds') ?? 0),
      });
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }
    if (failure) redirect(`/rate-limits?error=${encodeURIComponent(failure)}`);
    revalidatePath('/rate-limits');
    redirect('/rate-limits?saved=1');
  }

  return (
    <main>
      <header className="top">
        <h1>Rate limits</h1>
        <Nav here="rate-limits" />
      </header>

      {error ? <p className="error">{error}</p> : null}
      {saved ? <p className="faint">Saved.</p> : null}

      <p className="note" style={{ padding: 0 }}>
        The app&rsquo;s own abuse limiter, not Supabase&rsquo;s auth limiter (that one lives in the
        Supabase dashboard under Authentication &rsquo; Rate limits). Each bucket allows so many
        calls per window; a call over the line comes back <code>429 RATE_LIMITED</code>. A bucket
        with no row here uses the default compiled into <code>_shared/rateLimit.ts</code>. The
        counting fails open — if the database cannot be reached the call is allowed — so this is
        abuse control, never the paywall.
      </p>

      <h2>Master switch</h2>
      <section>
        <form action={toggleMaster} className="flag">
          <label className="inline">
            <input type="checkbox" name="enabled" defaultChecked={enabled} />
            <span>Rate limiting enabled</span>
          </label>
          <p className="note">
            Off exempts every bucket at once — the escape hatch for letting a support engineer
            replay a stuck queue. Nothing is counted while it is off, so turning it back on starts
            each bucket from a clean window.
          </p>
          <button type="submit">Save</button>
        </form>
      </section>

      <h2>Buckets</h2>
      {!enabled ? (
        <p className="note">The master switch is off, so these limits are not being applied.</p>
      ) : null}
      {rules.length === 0 ? (
        <section style={{ marginTop: 12 }}>
          <p className="note">
            No bucket rows. If you expected some, the
            <code> 20260809040000_rate_limit_controls </code> migration may not be deployed to this
            project — the app is still limited by the code defaults until it is.
          </p>
        </section>
      ) : null}

      {rules.map((rule: RateLimitRuleRow) => (
        <section key={rule.bucket}>
          <h3 style={{ margin: '0 0 8px' }}>
            <code>{rule.bucket}</code>{' '}
            <span className="faint">
              — {rule.max_calls} / {window(rule.window_seconds)}
              {rule.enabled ? '' : ' · off'}
            </span>
          </h3>
          <form action={saveRule} className="flag">
            <input type="hidden" name="bucket" value={rule.bucket} />
            <label className="inline">
              <input type="checkbox" name="enabled" defaultChecked={rule.enabled} />
              <span>Enabled</span>
            </label>
            <label>
              <span>Max calls</span>
              <input type="number" name="max_calls" min={0} defaultValue={rule.max_calls} />
            </label>
            <label>
              <span>Window (seconds)</span>
              <input
                type="number"
                name="window_seconds"
                min={1}
                defaultValue={rule.window_seconds}
              />
            </label>
            <button type="submit">Save</button>
          </form>
        </section>
      ))}

      <h2>Add a bucket</h2>
      <section>
        <form action={saveRule} className="flag">
          <label>
            <span>Bucket</span>
            <input type="text" name="bucket" placeholder="expense-write" required />
          </label>
          <label className="inline">
            <input type="checkbox" name="enabled" defaultChecked />
            <span>Enabled</span>
          </label>
          <label>
            <span>Max calls</span>
            <input type="number" name="max_calls" min={0} defaultValue={60} />
          </label>
          <label>
            <span>Window (seconds)</span>
            <input type="number" name="window_seconds" min={1} defaultValue={60} />
          </label>
          <button type="submit">Add</button>
        </form>
        <p className="note">
          Only a bucket the code actually calls will ever be consulted — adding a name here does not
          create a limiter, it overrides one. The names in use today are <code>sync</code>,{' '}
          <code>expense-write</code>, <code>export-data</code>, <code>fx-rate</code>,{' '}
          <code>invite-mint</code>, <code>invite-accept</code> and <code>receipt-parse</code>.
        </p>
      </section>
    </main>
  );
}
