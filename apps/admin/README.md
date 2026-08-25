# Baaki admin

A private console for one operator. Aggregates only — how the app is being
used, not what anybody spent money on.

English only, and deliberately: the product ships in four languages because its
users read four languages (TDR §11), and this has one reader. Numbers are
grouped `en-IN` because that is the market the business is in. Amounts still go
through `@waves/core`'s formatter rather than a local one, so the console can
never disagree with the ledger about what a number means.

Minimum responsive. It is read at a desk; the phone case is checking a figure
while away from one, so nothing is unreadable or unreachable and nothing more.

## What it can see

Six functions in `20260808190000_admin_analytics`, and nothing else. Not one of
them returns a description, a note, a display name, a payment handle or a
profile id.

| Function               | Answers                                              |
| ---------------------- | ---------------------------------------------------- |
| `baaki_admin_overview` | People, groups, expenses, settlements, active counts |
| `baaki_admin_daily`    | A row per day for 30 days, including empty ones      |
| `baaki_admin_geo`      | Counts per country                                   |
| `baaki_admin_money`    | Volume per currency, never converted                 |
| `baaki_admin_ai_cost`  | The receipt pipeline's bill (ADR-008/011)            |
| `baaki_admin_logins`   | Sign-ins per day, while Supabase still has them      |

They are revoked from `PUBLIC`, `anon` and `authenticated`, and granted to
`service_role` alone. That REVOKE is load-bearing: Postgres grants EXECUTE to
PUBLIC on every new function and Supabase's roles inherit PUBLIC, so without it
any anonymous guest could read the whole business through the anon key that
ships inside the mobile binary. `packages/db/test/adminAnalytics.test.ts` fails
if that ever regresses.

Two things it will not pretend to know:

- **Geo is the device locale**, read at signup — not IP geolocation. A phone set
  to `en-GB` in Bengaluru counts as GB.
- **Sign-ins come from `auth.audit_log_entries`**, which Supabase prunes. An
  empty chart means the retention window passed, not that nobody signed in.
  `last_sign_in_at` is deliberately unused: it is one snapshot per user, and
  grouping it by day draws a convincing chart of nothing.

## Running it locally

```bash
cp apps/admin/.env.example apps/admin/.env.local   # then fill it in
pnpm admin                                         # http://localhost:3100
```

## Deploying to Vercel

Already deployed, as the `baaki-admin` project. What follows is what it took,
because most of it is not obvious from the app's own config.

1. **Root Directory must be `apps/admin`** — Settings → General on the
   dashboard, or a `PATCH` to `/v9/projects/:id`. It is a project setting and
   cannot be expressed in `vercel.json`. Deploying from inside `apps/admin`
   instead fails at install: only that folder is uploaded, so
   `@waves/core: workspace:*` has nothing to resolve against.
2. **Link the CLI at the repository root**, not at `apps/admin`. The whole
   workspace has to be uploaded for pnpm to resolve it; Root Directory then
   tells Vercel which part of it to build. With the root linked but no Root
   Directory set, the build fails the other way — "No Next.js version
   detected", because it looked for `next` in the root manifest.
3. **`.vercelignore` at the repo root is load-bearing.** Without it the upload
   includes `node_modules`, the Android build tree and a 165MB APK, and aborts
   partway through 2.9GB.
4. Add the environment variables from `.env.example` for **Production**, plus
   the two this hardening added:
   - `ADMIN_ORIGIN_SECRET` — a long random string. It is the shared secret
     Cloudflare Access injects as a header and `src/proxy.ts` requires; see
     "The custom domain took that door away" below. **In production, if this is
     unset the proxy refuses every request** (fail-closed), so set it and the
     Cloudflare Transform Rule together.
   - `ADMIN_ALLOWED_ORIGIN` — optional, e.g. `https://baaki.dmadan.com`. Pins
     the origin the CSRF check compares against; leave it unset to derive the
     expected origin from the request `Host`, which is correct for a normal
     single-domain deployment.

   Generate a fresh `ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` and
   `ADMIN_ORIGIN_SECRET`; do not reuse the local ones. See "Rotate after
   hardening" below — anything that was live before this change should be
   rotated once, because it lived on a publicly reachable hostname.

5. Confirm **Deployment Protection → Vercel Authentication** covers Preview and
   Production. It was already on by default here — check rather than assume,
   with `vercel project protection`.

`apps/admin/vercel.json` pins the functions to `sin1`. The database is in
`ap-southeast-1`, and every page here is server-rendered from it — hosting the
functions anywhere else adds a transpacific round trip to each of six queries.

### Step 5 is not optional

Everything else here is one password in front of the entire business. Vercel
Authentication requires a login on your Vercel account before a request reaches
the app at all — including requests to the proxy — so an attacker never gets to
try the password. It also closes preview deployments, which otherwise publish a
working console at a fresh URL on every push.

The password is a single shared secret with no second factor and no revocation
short of changing it. That is an accepted trade for a one-person console _behind
another door_, and a bad one on its own.

### The custom domain took that door away

**Current state, and it is not the state above.** The console answers on
`baaki.dmadan.com`, and pointing a custom domain at a Vercel project removes it
from Vercel Authentication's scope. Verified rather than assumed:

```
baaki-admin-dmadan.vercel.app            302 → vercel.com/sso-api   (protected)
baaki-admin-git-main-dmadan.vercel.app   302 → vercel.com/sso-api   (protected)
baaki-admin.vercel.app                   307 → baaki.dmadan.com     (open)
baaki.dmadan.com                         307 → /login               (open)
```

The project is on the **Hobby** plan with
`ssoProtection: all_except_custom_domains`, and that is not a misconfiguration
to correct — it is the only setting Hobby has. Vercel's own words: "On the Hobby
plan … your production domain remains publicly accessible. To protect production
domains, you need a Pro or Enterprise plan." On Pro that scope is inside the
Advanced Deployment Protection add-on at $150/month with a 30-day minimum, and
Trusted IPs is Enterprise-only.

So the second door has to come from somewhere other than Vercel. `dmadan.com`
runs on Cloudflare and `baaki.dmadan.com` is currently DNS-only, which makes
**Cloudflare Access** the cheap answer: free to 50 seats, and a real second
factor by one-time PIN.

Two things that must be true together, or neither is worth doing:

1. `baaki.dmadan.com` proxied (orange cloud), SSL/TLS **Full (strict)**, with a
   Zero Trust Access application in front of it.
2. **The `.vercel.app` back door closed.** `baaki-admin.vercel.app` still serves
   this console, and a request sent straight to Vercel's IP with
   `Host: baaki.dmadan.com` walks around Cloudflare entirely. Closing it means a
   secret header injected by a Cloudflare Transform Rule that `src/proxy.ts`
   requires — a host check alone does not do it, because the host is exactly
   what an attacker sets.

**This is now enforced in the app.** `src/proxy.ts` refuses any request —
the login form included — that does not carry the header
`x-admin-origin-secret: <ADMIN_ORIGIN_SECRET>`. A valid session cookie is not
enough on its own: that is the whole point, because the cookie is the thing an
attacker on the open origin could obtain or replay. The compare is constant-time.

Ops steps to make it hold, in Cloudflare's dashboard:

1. **Zero Trust → Access → Applications**: add a self-hosted application for
   `baaki.dmadan.com` with a one-time-PIN (or stricter) policy for your email.
2. **Rules → Transform Rules → Modify Request Header**: on requests to
   `baaki.dmadan.com`, _set_ `x-admin-origin-secret` to the same value you put
   in the `ADMIN_ORIGIN_SECRET` env var. Set (not add), so a value a client
   tried to send cannot survive.
3. Set `ADMIN_ORIGIN_SECRET` in Vercel Production to that value and redeploy.

Fail-safe: if `ADMIN_ORIGIN_SECRET` is unset **in production** the proxy denies
everything rather than silently falling back to cookie-only — so a deploy that
forgets it is visibly broken, not quietly open. Off production (localhost dev)
an unset secret skips the check so the console still opens.

Until Access + the Transform Rule are live, treat `ADMIN_PASSWORD` as the only
control on a public hostname, and size it accordingly.

### Login throttling

`src/lib/loginThrottle.ts` caps failed password attempts per client address
(ten per fifteen minutes) using the same Postgres limiter the edge functions use
(`baaki_rate_limit`), so it works across Vercel's many short-lived isolates
where an in-memory counter would not. A lockout logs a line prefixed
`[ALERT] admin-login lockout` for log-based alerting to key on. It fails open: a
database blip lets the one operator in rather than locking them out. No
migration is needed — the bucket carries its own limit.

### CSRF / Origin on mutations

Every mutating server action calls `guardMutation` (`src/lib/csrf.ts`) first,
which requires two independent things: an `Origin` header matching this host
(or `ADMIN_ALLOWED_ORIGIN`), and a per-session CSRF token — derived from the
session cookie under `ADMIN_SESSION_SECRET`, carried by `<CsrfField />` in each
form. `SameSite=Lax` on the session cookie stays as one more layer, not the only
one. The login form has no session yet, so it enforces the Origin check alone.

### Rotate after hardening

`ADMIN_PASSWORD`, `ADMIN_SESSION_SECRET` and `ADMIN_ORIGIN_SECRET` must be
rotated **after** this is deployed, because until now the console answered on a
public hostname with only the password in front of it:

- **`ADMIN_PASSWORD`** — generate a new one; the old one may have been exposed to
  brute force on the open origin.
- **`ADMIN_SESSION_SECRET`** — rotating it invalidates every existing session
  cookie _and_ every CSRF token derived from one, forcing a fresh sign-in.
- **`ADMIN_ORIGIN_SECRET`** — set it for the first time here; rotate it (env +
  Cloudflare Transform Rule together) on any suspicion it leaked.

## Notes for whoever changes this next

- `src/lib/data.ts` begins with `import 'server-only'`. Keep it. It makes the
  build fail if this module is ever reached from a client component, which is
  the single mistake that would put an RLS-bypassing key into a browser bundle.
- The env vars are **not** `NEXT_PUBLIC_`. That prefix is exactly what would
  inline the service key into the client bundle.
- The gate is checked twice on purpose — in `src/proxy.ts` and again in
  `requireSession()`. This is not belt-and-braces for its own sake: during
  development the proxy sat at the project root, where Next silently does not
  load it, and only the second check stopped unauthenticated requests.
- Reads go through the `baaki_admin_*` functions rather than selecting from
  tables, so what this console is able to see stays one reviewable list in one
  migration instead of a habit spread across pages.
