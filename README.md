# Baaki

**பாக்கி — "balance / what's still owed".** An expense-splitting app for India:
unlimited free ledger, link-based guest joining, UPI-native settlement with
partial and per-expense payments, and free AI receipt itemization.

The two binding specs live in this repo: [`baaki-adr.md`](./baaki-adr.md) (14
accepted architecture decisions) and [`baaki-tdr.md`](./baaki-tdr.md) (how to
build them, milestone by milestone). **The ADRs are constraints, not
suggestions** — if code and ADR disagree, the ADR wins.

Current state: **M0 and M1 complete and verified against a live Supabase
project**, plus most of the M3 growth loop (invite links, joining without an
account, ghost claiming) and the M5 export. Still to come: offline sync (M2),
Splitwise import (M3), push/email delivery (M4), and the AI receipt scan (M5).

## Layout

```
apps/mobile/       Expo (SDK 57, React 19, Expo Router, TypeScript strict)
packages/core/     Pure money/split/balance/simplify/settlement logic — no deps
packages/db/       Prisma schema + migrations (RLS, triggers, derived balances)
packages/ui/       Design tokens and components
supabase/          Local stack config + edge functions (M2+)
e2e/               Maestro flows
```

`packages/core` has **zero runtime dependencies** on React or Supabase. That is
deliberate: the app, the guest web view and the Deno edge functions all import
the same module, so three runtimes can never disagree about what someone owes.

## Getting started

```bash
pnpm install

# money engine: 51 tests, property-based
pnpm test:core

# database: throwaway Postgres, migrations, RLS + invariant tests
pnpm db:pg:up
cp .env.example packages/db/.env      # defaults already point at the container
pnpm db:migrate
pnpm test:db
```

Requires Node 24+, pnpm 11+, and Docker.

### Screens

Sign in (phone OTP or guest) · Home · Activity · Account · New group ·
Group (expenses / balances / activity) · Expense detail with version history ·
Add or edit expense · Split by item · Settle up · Who pays whom · Members ·
Member detail · Group settings · Invite · Join from a link ·
Notification preferences · App lock · Export.

### Edge functions

| Function        | What it owns                                                                |
| --------------- | --------------------------------------------------------------------------- |
| `expense-write` | Recomputes every share with `@baaki/core` and writes the expense atomically |
| `invite-mint`   | Signed, expiring, revocable invite links (only a hash is stored)            |
| `invite-accept` | Preview without an account, join, and ghost claiming                        |
| `export-data`   | Lossless JSON and CSV export                                                |

### Running the full stack

The app talks to Supabase, so it needs the local stack rather than the bare
Postgres container above:

```bash
pnpm supabase:start                  # Postgres + Auth + PostgREST + Realtime + Edge runtime
pnpm db:migrate                      # point DIRECT_URL at the stack's db port first (54322)
pnpm edge:build                      # bundles @baaki/core for the Deno runtime
pnpm edge:serve                      # serves supabase/functions locally

# apps/mobile/.env — take the values printed by `supabase start`
#   EXPO_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321
#   EXPO_PUBLIC_SUPABASE_ANON_KEY=<anon key>
pnpm mobile
```

`supabase start` pulls ~10 container images the first time; on a slow or
proxied network that can take a while. To work against a hosted project
instead, point `packages/db/.env` at it and deploy the functions with
`pnpm edge:deploy`.

### Acceptance runs

These talk to a real Supabase project and are the reason M1 is called done:

```bash
ANON_KEY=... SERVICE_KEY=... node e2e/m1-acceptance.mjs   # 26 checks
ANON_KEY=... SERVICE_KEY=... node e2e/m3-invites.mjs      # 20 checks
```

## The invariants

These are the product promise, so they are tests, and CI blocks a merge if any
of them break:

| Invariant                                              | Where                                          |
| ------------------------------------------------------ | ---------------------------------------------- |
| Σ shares === expense total, for every split type       | `packages/core/test/split.property.test.ts`    |
| Σ balances === 0, per group per currency               | `packages/core/test/balances.property.test.ts` |
| Simplification never changes anyone's net position     | `packages/core/test/simplify.property.test.ts` |
| FX conversions are exactly reproducible                | `packages/core/test/money.test.ts`             |
| Stored balances === the ground-truth aggregate         | `packages/db/test/invariants.test.ts`          |
| Non-members can read nothing; guests only their group  | `packages/db/test/rls.test.ts`                 |
| Expense history cannot be rewritten or hard-deleted    | `packages/db/test/invariants.test.ts`          |
| Only a group member can create, delete or settle in it | `packages/db/test/m1-rpcs.test.ts`             |
| Only the payee can confirm a settlement                | `packages/db/test/m1-rpcs.test.ts`             |
| Replaying a mutation id never double-posts             | `packages/db/test/m1-rpcs.test.ts`             |

The client also recomputes each group's balances with `@baaki/core` and compares
them against the server's `group_balances`. If they ever disagree, the group
screen says so rather than showing a number that might be wrong.

## Money rules

- Amounts are **`BIGINT` minor units** plus an ISO-4217 code. No float, no
  decimal, anywhere (ADR-003).
- Balances are **always derived**, never stored as a mutable running total
  (ADR-004). The Postgres tables are a cache that CI proves equal to the
  aggregate.
- The remainder of an uneven split rotates by expense id, so the same person
  does not always absorb the extra paisa (ADR-009).
- Baaki **never moves money**. Settlement opens a UPI intent in the payer's own
  app and records the outcome (ADR-007).

## Monetization guardrail (ADR-011)

Manual expense entry, groups, all split types, balances, settlement recording
and export are **unlimited and free, forever**. No daily caps, no ads in a money
flow. Convenience is what gets monetized: AI scan volume beyond the free quota,
deeper analytics, trip passes, themes. Treat this as a review checklist item.
