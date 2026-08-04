# Baaki

**பாக்கி — "balance / what's still owed".** An expense-splitting app for India:
unlimited free ledger, link-based guest joining, UPI-native settlement with
partial and per-expense payments, and free AI receipt itemization.

The two binding specs live in this repo: [`baaki-adr.md`](./baaki-adr.md) (14
accepted architecture decisions) and [`baaki-tdr.md`](./baaki-tdr.md) (how to
build them, milestone by milestone). **The ADRs are constraints, not
suggestions** — if code and ADR disagree, the ADR wins.

Current state: **M0 complete** (foundations, money engine, database, design
system, navigable app shell on fixture data). M1 onwards — real auth, live
CRUD, offline sync, invites, UPI, AI receipts — is not started.

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

# the app
pnpm mobile
```

Requires Node 24+, pnpm 11+, and Docker for the database.

## The invariants

These are the product promise, so they are tests, and CI blocks a merge if any
of them break:

| Invariant                                             | Where                                          |
| ----------------------------------------------------- | ---------------------------------------------- |
| Σ shares === expense total, for every split type      | `packages/core/test/split.property.test.ts`    |
| Σ balances === 0, per group per currency              | `packages/core/test/balances.property.test.ts` |
| Simplification never changes anyone's net position    | `packages/core/test/simplify.property.test.ts` |
| FX conversions are exactly reproducible               | `packages/core/test/money.test.ts`             |
| Stored balances === the ground-truth aggregate        | `packages/db/test/invariants.test.ts`          |
| Non-members can read nothing; guests only their group | `packages/db/test/rls.test.ts`                 |
| Expense history cannot be rewritten or hard-deleted   | `packages/db/test/invariants.test.ts`          |

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
