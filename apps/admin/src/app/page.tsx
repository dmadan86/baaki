import { format, money, type CurrencyCode } from '@waves/core';
import type { ReactNode } from 'react';

import { Bars } from '@/components/Bars';
import { AreaTrend } from '@/components/charts/AreaTrend';
import { DonutChart } from '@/components/charts/DonutChart';
import { aiCost, daily, geo, logins, money as moneyRows, overview } from '@/lib/data';

export const dynamic = 'force-dynamic';

const num = (value: number | string) => Number(value).toLocaleString('en-IN');

/** Minor units through the ledger's own formatter, so the console cannot disagree with the app. */
function amount(minor: string, currency: string): string {
  try {
    return format(money(BigInt(minor), currency as CurrencyCode), { compactFraction: true });
  } catch {
    // An unknown currency is not worth a 500 on a dashboard.
    return `${minor} ${currency}`;
  }
}

export default async function Dashboard() {
  const [head, days, countries, currencies, ai, signIns] = await Promise.all([
    overview(),
    daily(30),
    geo(),
    moneyRows(),
    aiCost(30),
    logins(30),
  ]);

  if (!head) {
    return (
      <main>
        <h1>Baaki admin</h1>
        <p className="note">
          The analytics functions returned nothing. That usually means the
          <code> 20260808190000_admin_analytics </code> migration has not been deployed to this
          project yet.
        </p>
      </main>
    );
  }

  const signInTotal = signIns.rows.reduce((sum, row) => sum + Number(row.sign_ins), 0);

  const trend = days.map((d) => ({
    day: d.day,
    newProfiles: Number(d.new_profiles),
    newExpenses: Number(d.new_expenses),
    active: Number(d.active_profiles),
  }));

  // Share of live expenses by currency — the one split with few enough slices
  // to read as a ring. Never summed across currencies, so this counts expenses,
  // not value.
  const currencySlices = currencies
    .map((row) => ({ name: row.currency, value: Number(row.expense_count) }))
    .filter((s) => s.value > 0)
    .sort((a, b) => b.value - a.value);

  return (
    <main>
      <header className="top">
        <h1>Dashboard</h1>
        <p className="faint">
          {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
        </p>
      </header>

      <section className="hero">
        <div>
          <div className="who">Baaki, at a glance</div>
          <div className="big">{num(head.active_profiles_30d)}</div>
          <div className="lead">people active in the last 30 days</div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="big">{num(head.active_profiles_7d)}</div>
          <div className="lead">active in the last 7 days</div>
        </div>
      </section>

      <div className="stats">
        <Stat
          tint="purple"
          icon={ICON.people}
          label="People"
          value={num(head.profiles_total)}
          chip={`+${num(head.profiles_new_7d)} in 7d`}
          dir={Number(head.profiles_new_7d) > 0 ? 'up' : 'flat'}
        />
        <Stat
          tint="blue"
          icon={ICON.group}
          label="Groups"
          value={num(head.groups_total)}
          chip={`${num(head.groups_active_30d)} active`}
          dir="flat"
        />
        <Stat
          tint="green"
          icon={ICON.receipt}
          label="Expenses"
          value={num(head.expenses_total)}
          chip={`+${num(head.expenses_new_30d)} in 30d`}
          dir={Number(head.expenses_new_30d) > 0 ? 'up' : 'flat'}
        />
        <Stat
          tint="amber"
          icon={ICON.check}
          label="Settlements"
          value={num(head.settlements_total)}
          chip={`${num(head.settlements_confirmed)} confirmed`}
          dir="flat"
        />
        <Stat
          tint="blue"
          icon={ICON.pulse}
          label="Active 30d"
          value={num(head.active_profiles_30d)}
          chip={`${num(head.active_profiles_7d)} in 7d`}
          dir="flat"
        />
        <Stat
          tint="red"
          icon={ICON.trash}
          label="Deleted expenses"
          value={num(head.expenses_deleted)}
          chip="soft-deleted"
          dir="flat"
        />
      </div>

      <div className="grid-2" style={{ marginTop: 18 }}>
        <div className="card">
          <div className="card-head">
            <h3>Expenses by currency</h3>
          </div>
          <p className="card-sub">Live expenses, counted — never summed across currencies.</p>
          {currencySlices.length === 0 ? (
            <p className="note">No expenses yet.</p>
          ) : (
            <div className="echart">
              <DonutChart slices={currencySlices} centerLabel="expenses" />
            </div>
          )}
        </div>

        <div className="card">
          <AreaTrend days={trend} />
          <p className="card-sub" style={{ paddingTop: 0 }}>
            Active means the ledger recorded something. Opening the app is not written down, so it
            is not counted here.
          </p>
        </div>
      </div>

      <h2>Where they are</h2>
      <section className="scroll">
        <table>
          <thead>
            <tr>
              <th>Country</th>
              <th>People</th>
              <th>Groups</th>
              <th>Expenses</th>
            </tr>
          </thead>
          <tbody>
            {countries.map((row) => (
              <tr key={row.country_code ?? 'unknown'}>
                <td>{row.country_code ?? <span className="muted">Not set</span>}</td>
                <td>{num(row.profile_count)}</td>
                <td>{num(row.group_count)}</td>
                <td>{num(row.expense_count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          This is the device locale the app read at signup, and for groups it is where the group
          settles. It is not IP geolocation: a phone set to en-GB in Bengaluru counts as GB.
        </p>
      </section>

      <h2>Volume</h2>
      <section className="scroll">
        <table>
          <thead>
            <tr>
              <th>Currency</th>
              <th>Expenses</th>
              <th>Value</th>
              <th>Settled</th>
              <th>Settled value</th>
            </tr>
          </thead>
          <tbody>
            {currencies.map((row) => (
              <tr key={row.currency}>
                <td>{row.currency}</td>
                <td>{num(row.expense_count)}</td>
                <td>{amount(row.expense_minor, row.currency)}</td>
                <td>{num(row.settlement_count)}</td>
                <td>{amount(row.settlement_minor, row.currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="note">
          Never summed across currencies and never converted — the same rule the product follows.
          Live expenses at their current version only, so an edited expense counts once.
        </p>
      </section>

      <h2>AI receipt cost, 30 days</h2>
      <section className="scroll">
        {ai.length === 0 ? (
          <p className="note">No scans in this window.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Day</th>
                <th>Currency</th>
                <th>Scans</th>
                <th>In</th>
                <th>Out</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {ai.map((row) => (
                <tr key={`${row.day}-${row.currency}`}>
                  <td>{row.day}</td>
                  <td>{row.currency}</td>
                  <td>{num(row.events)}</td>
                  <td>{num(row.input_tokens)}</td>
                  <td>{num(row.output_tokens)}</td>
                  <td>{amount(row.cost_minor, row.currency)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <h2>Sign-ins, 30 days</h2>
      <section>
        {signIns.unavailable ? (
          // Said plainly, and not as an empty chart. This is the only panel
          // reading outside `public`, so it is the only one whose failure means
          // "the grant is missing" rather than "nobody did anything".
          <p className="note">
            Sign-in history could not be read: <code>{signIns.unavailable}</code>. Everything else
            on this page is unaffected.
          </p>
        ) : signIns.rows.length === 0 ? (
          <p className="note">
            Nothing to show. Supabase prunes its auth audit log, so an empty result here means the
            retention window has passed — not that nobody signed in.
          </p>
        ) : (
          <>
            <Bars
              label="Sign-ins per day"
              rows={[...signIns.rows]
                .reverse()
                .map((row) => ({ day: row.day, value: Number(row.sign_ins) }))}
            />
            <p className="note">{num(signInTotal)} sign-ins in the retained window.</p>
          </>
        )}
      </section>

      <h2>Reports</h2>
      <section>
        {/* Plain anchors on purpose. These are route handlers that stream a
            file with a Content-Disposition, not pages: `next/link` would
            client-side navigate to them and the download would never start. */}
        {/* eslint-disable @next/next/no-html-link-for-pages */}
        <p className="note">
          <a href="/export/daily">daily.csv</a> · <a href="/export/geo">geo.csv</a> ·{' '}
          <a href="/export/money">money.csv</a> · <a href="/export/ai">ai-cost.csv</a>
        </p>
        {/* eslint-enable @next/next/no-html-link-for-pages */}
      </section>
    </main>
  );
}

function Stat({
  tint,
  icon,
  label,
  value,
  chip,
  dir,
}: {
  tint: 'blue' | 'green' | 'amber' | 'red' | 'purple';
  icon: ReactNode;
  label: string;
  value: string;
  chip: string;
  dir: 'up' | 'down' | 'flat';
}) {
  return (
    <div className="stat">
      <div className={`ico tint-${tint}`}>{icon}</div>
      <span className="label">{label}</span>
      <div className="figure">
        <span className="value">{value}</span>
        <span className={`chip ${dir}`}>{chip}</span>
      </div>
    </div>
  );
}

/** Stroke icons for the stat cards, matched to the sidebar's set. */
const ICON = {
  people: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor">
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 20a5.5 5.5 0 0 1 11 0" />
      <path d="M16 5.2a3.2 3.2 0 0 1 0 5.6M17.5 14.4A5.5 5.5 0 0 1 20.5 19" />
    </svg>
  ),
  group: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4v16M4 12h16" />
    </svg>
  ),
  receipt: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor">
      <path d="M6 3h12v18l-3-2-3 2-3-2-3 2V3z" />
      <path d="M9 8h6M9 12h6" />
    </svg>
  ),
  check: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor">
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.5l2.5 2.5 4.5-5" />
    </svg>
  ),
  pulse: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor">
      <path d="M3 12h4l2.5-6 4 12 2.5-6H21" />
    </svg>
  ),
  trash: (
    <svg viewBox="0 0 24 24" aria-hidden fill="none" stroke="currentColor">
      <path d="M4 7h16M9 7V5h6v2M6 7l1 13h10l1-13" />
    </svg>
  ),
} as const;
