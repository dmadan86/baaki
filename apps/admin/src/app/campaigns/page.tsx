import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { format, money, type CurrencyCode } from '@waves/core';

import {
  broadcastCampaign,
  campaignEmailStats,
  campaignFunnel,
  campaignRevenue,
  campaigns,
  createCampaign,
  promoCodes,
  type CampaignEmailStatRow,
  type CampaignRevenueRow,
  type FunnelRow,
} from '@/lib/data';
import { guardMutation } from '@/lib/csrf';
import { CsrfField } from '@/components/CsrfField';

export const dynamic = 'force-dynamic';

const num = (value: number | string) => Number(value).toLocaleString('en-IN');
const pct = (part: number, whole: number) =>
  whole === 0 ? '—' : `${((part / whole) * 100).toFixed(1)}%`;

function amount(minor: string, currency: string): string {
  try {
    return format(money(BigInt(minor), currency as CurrencyCode), { compactFraction: true });
  } catch {
    return `${minor} ${currency}`;
  }
}

/**
 * The number the whole feature exists for.
 *
 * Revenue per person in the targeted arm minus revenue per person in the
 * holdout, times the targeted population. Per person because the arms are
 * different sizes; against the holdout because the value of what was given away
 * is not an impact, it is a cost.
 */
function incremental(rows: CampaignRevenueRow[], funnel: FunnelRow[], currency: string) {
  const heads = new Map(funnel.map((row) => [row.cohort, BigInt(row.people)]));
  const revenueFor = (cohort: string) =>
    BigInt(
      rows.find((row) => row.cohort === cohort && row.currency === currency)?.revenue_minor ?? 0,
    );

  const targetedPeople = heads.get('targeted') ?? 0n;
  const holdoutPeople = heads.get('holdout') ?? 0n;
  if (targetedPeople === 0n || holdoutPeople === 0n) return null;

  // Per-person revenue times the targeted population, done in exact minor units.
  // The per-targeted term collapses to the targeted revenue itself; only the
  // holdout share carries a division, rounded to the nearest minor unit
  // (round half up — both operands are non-negative here).
  const revTargeted = revenueFor('targeted');
  const revHoldout = revenueFor('holdout');
  const holdoutShare = (revHoldout * targetedPeople + holdoutPeople / 2n) / holdoutPeople;
  return revTargeted - holdoutShare;
}

export default async function Campaigns({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; done?: string }>;
}) {
  const { error, done } = await searchParams;
  const [all, codes] = await Promise.all([campaigns(), promoCodes()]);

  const results = new Map(
    await Promise.all(
      all.map(
        async (campaign) =>
          [
            campaign.id,
            {
              funnel: await campaignFunnel(campaign.id),
              revenue: await campaignRevenue(campaign.id),
              email: await campaignEmailStats(campaign.id),
            },
          ] as const,
      ),
    ),
  );

  async function create(formData: FormData) {
    'use server';

    const countries = String(formData.get('countries') ?? '')
      .split(',')
      .map((part) => part.trim().toUpperCase())
      .filter(Boolean);

    let failure: string | null = null;
    try {
      await guardMutation(formData);
      await createCampaign({
        name: String(formData.get('name') ?? ''),
        title: String(formData.get('title') ?? ''),
        body: String(formData.get('body') ?? ''),
        ctaLabel: String(formData.get('cta') ?? ''),
        promoCode: String(formData.get('code') ?? '') || null,
        endsAt: String(formData.get('ends') ?? ''),
        countries: countries.length > 0 ? countries : null,
        holdoutPercent: Number(formData.get('holdout') ?? 10),
      });
    } catch (caught) {
      failure = caught instanceof Error ? caught.message : String(caught);
    }

    if (failure) redirect(`/campaigns?error=${encodeURIComponent(failure)}`);
    revalidatePath('/campaigns');
    redirect('/campaigns?done=Campaign+created');
  }

  async function broadcast(formData: FormData) {
    'use server';

    const id = String(formData.get('id') ?? '');
    let message: string;
    try {
      await guardMutation(formData);
      const result = await broadcastCampaign(id);
      // The holdout is never in this count — it is the control group, and mailing
      // it is the one thing the whole design forbids.
      message = `Sent ${result.sent}, ${result.failed} failed${
        result.more ? ' · more to send, press again' : ''
      }`;
    } catch (caught) {
      const failure = caught instanceof Error ? caught.message : String(caught);
      redirect(`/campaigns?error=${encodeURIComponent(failure)}`);
    }

    revalidatePath('/campaigns');
    redirect(`/campaigns?done=${encodeURIComponent(message)}`);
  }

  return (
    <main>
      <header className="top">
        <h1>Campaigns</h1>{' '}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {done ? <p className="faint">{done}</p> : null}

      <p className="note" style={{ padding: 0 }}>
        Every campaign withholds itself from a slice of its own audience. That holdout is the only
        reason &ldquo;did this work&rdquo; has an answer: a comped subscription earns nothing by
        construction, so the impact is whether the people who were offered it went on to pay more
        than the people who were not.
      </p>

      {all.length === 0 ? (
        <section style={{ marginTop: 20 }}>
          <p className="note">
            None yet. If you expected some, the <code>20260808220000_campaigns</code> migration may
            not be deployed to this project.
          </p>
        </section>
      ) : null}

      {all.map((campaign) => {
        const result = results.get(campaign.id);
        const funnel = result?.funnel ?? [];
        const revenue = result?.revenue ?? [];
        const emailStats: CampaignEmailStatRow[] = result?.email ?? [];
        const emailCount = (status: string) =>
          Number(emailStats.find((row) => row.status === status)?.count ?? 0);
        const targeted = funnel.find((row) => row.cohort === 'targeted');
        const currencies = [...new Set(revenue.map((row) => row.currency))];
        const live =
          new Date(campaign.starts_at) <= new Date() && new Date(campaign.ends_at) > new Date();

        return (
          <div key={campaign.id}>
            <h2>
              {campaign.name} {live ? '· live' : '· ended'}
            </h2>
            <section>
              <p className="note">
                <strong>{campaign.title}</strong>
                {campaign.body ? ` — ${campaign.body}` : ''}
                <br />
                {campaign.promo_code ? (
                  <>
                    Code <code>{campaign.promo_code}</code> ·{' '}
                  </>
                ) : null}
                {campaign.holdout_percent}% holdout ·{' '}
                {campaign.audience_countries?.join(', ') || 'everywhere'} · ends{' '}
                {new Date(campaign.ends_at).toLocaleDateString('en-IN')}
              </p>

              <div className="scroll">
                <table>
                  <thead>
                    <tr>
                      <th>Cohort</th>
                      <th>People</th>
                      <th>Saw it</th>
                      <th>Redeemed</th>
                      <th>Paid</th>
                      <th>Pay rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {funnel.map((row) => (
                      <tr key={row.cohort}>
                        <td>{row.cohort}</td>
                        <td>{num(row.people)}</td>
                        <td>{num(row.seen)}</td>
                        <td>{num(row.redeemed)}</td>
                        <td>{num(row.paid)}</td>
                        <td>{pct(Number(row.paid), Number(row.people))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {currencies.length === 0 ? (
                <p className="note">No purchases in either arm yet.</p>
              ) : (
                <div className="scroll">
                  <table>
                    <thead>
                      <tr>
                        <th>Currency</th>
                        <th>Targeted</th>
                        <th>Holdout</th>
                        <th>Incremental</th>
                      </tr>
                    </thead>
                    <tbody>
                      {currencies.map((currency) => {
                        const lift = incremental(revenue, funnel, currency);
                        const forCohort = (cohort: string) =>
                          revenue.find((row) => row.cohort === cohort && row.currency === currency)
                            ?.revenue_minor ?? '0';
                        return (
                          <tr key={currency}>
                            <td>{currency}</td>
                            <td>{amount(forCohort('targeted'), currency)}</td>
                            <td>{amount(forCohort('holdout'), currency)}</td>
                            <td
                              style={{
                                color:
                                  lift === null
                                    ? 'var(--muted)'
                                    : lift >= 0n
                                      ? 'var(--positive)'
                                      : 'var(--negative)',
                                fontWeight: 600,
                              }}
                            >
                              {lift === null ? '—' : amount(String(lift), currency)}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                  <p className="note">
                    Incremental is revenue per person in the targeted arm minus revenue per person
                    in the holdout, times the targeted population. Per person because the arms are
                    different sizes. It goes negative when the giveaway cannibalised purchases
                    people would have made anyway, and that is a real result rather than a bug.
                    {targeted && Number(targeted.people) < 200 ? (
                      <>
                        {' '}
                        With {num(targeted.people)} people in the targeted arm this is noisy — treat
                        it as a direction, not a figure.
                      </>
                    ) : null}
                  </p>
                </div>
              )}
              <div style={{ marginTop: 16 }}>
                <p className="note" style={{ padding: 0 }}>
                  <strong>Email</strong> — sent {num(emailCount('sent'))}
                  {emailCount('failed') > 0 ? `, ${num(emailCount('failed'))} failed` : ''}
                  {emailCount('queued') > 0 ? `, ${num(emailCount('queued'))} in flight` : ''}. The
                  holdout is never mailed, so this reaches the targeted cohort only.
                </p>
                {live ? (
                  <form action={broadcast}>
                    <CsrfField />
                    <input type="hidden" name="id" value={campaign.id} />
                    <button type="submit">Send email to targeted cohort</button>
                  </form>
                ) : (
                  <p className="note">
                    Email only sends while a campaign is live. This one is not running now.
                  </p>
                )}
              </div>
            </section>
          </div>
        );
      })}

      <h2>New campaign</h2>
      <section>
        <form action={create} className="flag">
          <CsrfField />
          <label>
            <span>Name (internal)</span>
            <input type="text" name="name" placeholder="Diwali 2026" />
          </label>
          <label>
            <span>Title</span>
            <input type="text" name="title" placeholder="Two months of Plus, free" required />
          </label>
          <label>
            <span>Body</span>
            <input type="text" name="body" placeholder="Because you have been here a while" />
          </label>
          <label>
            <span>Button</span>
            <input type="text" name="cta" placeholder="Claim it" defaultValue="Claim it" />
          </label>
          <label>
            <span>Promo code</span>
            <select name="code" defaultValue="">
              <option value="">None</option>
              {codes.map((code) => (
                <option key={code.code} value={code.code}>
                  {code.code}
                </option>
              ))}
            </select>
          </label>
          <label>
            <span>Ends</span>
            <input type="date" name="ends" required />
          </label>
          <label>
            <span>Countries</span>
            <input type="text" name="countries" placeholder="IN, AE — blank for all" />
          </label>
          <label>
            <span>Holdout %</span>
            <input type="number" name="holdout" min={1} max={90} defaultValue={10} />
          </label>
          <button type="submit">Create campaign</button>
        </form>
      </section>
    </main>
  );
}
