import { format, money, type CurrencyCode } from '@baaki/core';

import { Bars } from '@/components/Bars';
import { Nav } from '@/components/Nav';
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

  const signInTotal = signIns.reduce((sum, row) => sum + Number(row.sign_ins), 0);

  return (
    <main>
      <header className="top">
        <h1>Baaki admin</h1>
        <Nav here="overview" />
      </header>
      <p className="faint" style={{ marginTop: -18, marginBottom: 22 }}>
        Aggregates only · {new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} IST
      </p>

      <div className="tiles">
        <Tile
          label="People"
          value={num(head.profiles_total)}
          sub={`+${head.profiles_new_7d} in 7d`}
        />
        <Tile
          label="Groups"
          value={num(head.groups_total)}
          sub={`${num(head.groups_active_30d)} active in 30d`}
        />
        <Tile
          label="Expenses"
          value={num(head.expenses_total)}
          sub={`+${num(head.expenses_new_30d)} in 30d`}
        />
        <Tile
          label="Settlements"
          value={num(head.settlements_total)}
          sub={`${num(head.settlements_confirmed)} confirmed`}
        />
        <Tile
          label="Active 30d"
          value={num(head.active_profiles_30d)}
          sub={`${num(head.active_profiles_7d)} in 7d`}
        />
        <Tile label="Deleted expenses" value={num(head.expenses_deleted)} sub="soft-deleted" />
      </div>

      <h2>New people, 30 days</h2>
      <section>
        <Bars
          label="New people per day"
          rows={days.map((d) => ({ day: d.day, value: Number(d.new_profiles) }))}
        />
      </section>

      <h2>Expenses created, 30 days</h2>
      <section>
        <Bars
          label="Expenses created per day"
          rows={days.map((d) => ({ day: d.day, value: Number(d.new_expenses) }))}
        />
      </section>

      <h2>Active people, 30 days</h2>
      <section>
        <Bars
          label="Active people per day"
          rows={days.map((d) => ({ day: d.day, value: Number(d.active_profiles) }))}
        />
        <p className="note">
          Active means somebody did something the ledger recorded. Opening the app is not written
          down anywhere, so it is not counted here — a number that meant &ldquo;launched&rdquo;
          would be invented.
        </p>
      </section>

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
        {signIns.length === 0 ? (
          <p className="note">
            Nothing to show. Supabase prunes its auth audit log, so an empty result here means the
            retention window has passed — not that nobody signed in.
          </p>
        ) : (
          <>
            <Bars
              label="Sign-ins per day"
              rows={[...signIns]
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

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="tile">
      <span className="label">{label}</span>
      <div className="value">{value}</div>
      {sub ? <div className="sub">{sub}</div> : null}
    </div>
  );
}
