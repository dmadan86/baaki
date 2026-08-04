# Baaki — Technical Design Record (TDR)

**Companion to:** `baaki-adr.md` (the ADRs are binding; this TDR describes *how* to build them).
**Audience:** Claude Code (or any engineer) implementing the product. Build in milestone order (§10); each milestone has acceptance criteria.

---

## 1. System overview

```
┌─────────────────────────────┐        ┌──────────────────────────────────┐
│  Mobile app (Expo RN, TS)   │        │  Supabase                        │
│  ├── UI (Expo Router)       │◄──────►│  ├── Postgres (source of truth)  │
│  ├── Local SQLite mirror    │ sync   │  │    ├── RLS policies           │
│  ├── Mutation queue         │        │  │    ├── triggers → balances MV │
│  └── UPI intent launcher    │        │  ├── Auth (anon/OTP/OAuth)       │
└─────────────────────────────┘        │  ├── Realtime (group channels)   │
┌─────────────────────────────┐        │  ├── Storage (receipts, private) │
│  Guest web-lite (link view) │◄──────►│  └── Edge Functions (Deno):      │
│  (served page + anon auth)  │        │      invite-mint, ghost-claim,   │
└─────────────────────────────┘        │      receipt-parse (LLM), export,│
                                       │      notify-fanout, splitwise-   │
        Claude API (vision) ◄──────────│      import                      │
        Expo Push / Resend  ◄──────────└──────────────────────────────────┘
```

**Monorepo layout**

```
baaki/
├── apps/mobile/            # Expo app (TypeScript strict)
├── apps/web-lite/          # guest link view (minimal Next.js or Expo Web)
├── packages/core/          # PURE shared logic: money, splits, simplify, sync protocol types
├── packages/db/            # Prisma: schema.prisma, migrations/, generated client
├── supabase/
│   └── functions/          # edge functions (invite-mint, receipt-parse, notify-fanout, …)
├── e2e/                    # Maestro flows
└── .github/workflows/      # CI: typecheck, unit+property, RLS tests, e2e
```

`packages/core` must have **zero runtime dependencies on React/Supabase** — it is the deterministic math/protocol library shared by app, web-lite, and edge functions, and is where property tests live.

---

## 2. Data model (Postgres)

### 2.0 Migrations & ORM — Prisma

**Prisma is the schema source of truth and migration engine.** `packages/db` holds `schema.prisma`; `prisma migrate dev` generates versioned SQL migrations, applied to Supabase Postgres via the **direct (non-pooled) connection string**; runtime queries from edge functions use the pooled connection (Supabase pgbouncer) with `directUrl`/`url` split in the datasource block.

Rules:
- Everything Prisma can express (tables, columns, enums, indexes, FKs, uniques) lives in `schema.prisma`.
- Everything Prisma cannot express — **RLS policies, security-definer functions, triggers, materialized views (`group_balances`), CHECK-by-trigger money invariants** — is written as raw SQL appended to the generated `migration.sql` files (Prisma's supported customize-migration workflow: `prisma migrate dev --create-only`, edit, then apply). These SQL blocks are part of the migration history and reviewed like code.
- The Prisma schema must **exclude Supabase-managed schemas** (`auth`, `storage`, `realtime`) — set `schemas = ["public"]`; never migrate those.
- Generated Prisma Client is used by edge functions and any future server code; the mobile client never talks Prisma — it goes through supabase-js (RLS-enforced) and the `/sync` function.
- CI: `prisma migrate diff` guards drift (schema ↔ database), and migrations are tested apply→rollback against a disposable local Postgres.

All money columns `BIGINT` minor units (ADR-003). All tables: `id UUID PK DEFAULT gen_random_uuid()`, `created_at`, `updated_at`. Append-only semantics per ADR-004.

```sql
-- Identity
profiles(id UUID PK ↔ auth.users, display_name TEXT, avatar_url TEXT,
         default_vpa TEXT NULL, default_currency CHAR(3) DEFAULT 'INR',
         notification_prefs JSONB)

-- Groups & membership
groups(id, name, type TEXT CHECK (type IN ('trip','home','couple','event','other')),
       default_currency CHAR(3), simplify_debts BOOL DEFAULT true,
       cover_emoji TEXT, archived_at TIMESTAMPTZ NULL)

group_members(id, group_id FK, profile_id FK NULL,      -- NULL ⇒ ghost member
              ghost_name TEXT NULL,                     -- exactly one of profile_id/ghost_name
              role TEXT CHECK (role IN ('admin','member')) DEFAULT 'member',
              joined_via TEXT, left_at TIMESTAMPTZ NULL,
              UNIQUE(group_id, profile_id))

invites(id, group_id FK, token_hash TEXT, created_by FK,
        expires_at, revoked_at NULL, max_uses INT, use_count INT)

-- Expenses (append-only; current state = latest version)
expenses(id, group_id FK, current_version_id FK, created_by FK,
         deleted_at NULL, deleted_by NULL)

expense_versions(id, expense_id FK, version_no INT, author_member_id FK,
                 description TEXT, category TEXT, expense_date DATE,
                 currency CHAR(3), amount BIGINT,
                 split_type TEXT CHECK (split_type IN
                   ('equal','exact','percent','shares','adjustment','itemized')),
                 split_params JSONB,        -- weights/percents/adjustments per member
                 fx JSONB NULL,             -- {num, den, ts, source} if ≠ group currency
                 receipt_id FK NULL, notes TEXT,
                 client_mutation_id UUID UNIQUE,        -- idempotency (ADR-005)
                 UNIQUE(expense_id, version_no))

expense_payers(expense_version_id FK, member_id FK, amount BIGINT)   -- multi-payer
expense_shares(expense_version_id FK, member_id FK, amount BIGINT)   -- computed, exact
-- CHECK-by-trigger: Σpayers = Σshares = amount

-- Receipts & itemization
receipts(id, group_id FK, storage_path TEXT, source TEXT CHECK (source IN
         ('camera','gallery','text_paste')), raw_text TEXT NULL,
         parse_status TEXT, parsed JSONB NULL,   -- schema in §6
         confidence JSONB NULL)
receipt_item_claims(receipt_id FK, item_index INT, member_id FK,
                    UNIQUE(receipt_id, item_index, member_id))

-- Settlements (ADR-007)
settlements(id, group_id FK, from_member_id FK, to_member_id FK,
            currency CHAR(3), amount BIGINT,
            method TEXT CHECK (method IN ('upi','cash','bank','other')),
            status TEXT CHECK (status IN ('initiated','confirmed','auto_confirmed',
                                          'disputed','cancelled')),
            initiated_at, confirmed_at NULL, note TEXT,
            client_mutation_id UUID UNIQUE)
settlement_allocations(settlement_id FK, expense_id FK, amount BIGINT)  -- partial/per-expense

-- Audit & notifications
activity_log(id, group_id FK, actor_member_id FK, verb TEXT, object_type TEXT,
             object_id UUID, payload JSONB, created_at)
reminders(id, group_id FK, from_member_id FK, to_member_id FK, due_date DATE NULL,
          last_nudged_at, auto BOOLEAN)

push_tokens(id, profile_id FK, expo_push_token TEXT UNIQUE, platform TEXT
            CHECK (platform IN ('ios','android')), device_name TEXT,
            last_seen_at, revoked_at NULL)

notifications(id, profile_id FK, group_id FK NULL, kind TEXT,      -- in-app inbox
              title TEXT, body TEXT, deep_link TEXT, payload JSONB,
              channels TEXT[],                 -- ['push','email','inapp']
              push_status TEXT NULL,           -- queued|sent|delivered|failed
              email_status TEXT NULL,          -- queued|sent|bounced|complained
              read_at NULL, created_at)

email_events(id, notification_id FK NULL, profile_id FK, resend_email_id TEXT,
             template TEXT, event TEXT,        -- sent|delivered|bounced|complained|opened
             payload JSONB, created_at)        -- fed by Resend webhook

-- Derived (trigger-maintained; ground truth = aggregate query; CI asserts equality)
group_balances(group_id, member_id, currency, balance BIGINT)  -- Σ=0 per (group,currency)
pairwise_balances(group_id, from_member_id, to_member_id, currency, amount BIGINT)
```

**RLS sketch (ADR-013):** every table policy reduces to `is_group_member(group_id, auth.uid())` (security-definer fn resolving both real and anonymous-JWT-scoped membership); `profiles` self-only; `invites` insert by members, select never (token verified in edge function against hash); privileged mutations (ghost claim, imports) service-role-only.

---

## 3. Core algorithms (`packages/core`)

### 3.1 Split computation
`computeShares(amount, currency, splitType, params, members) → Map<memberId, minorUnits>`
- equal: floor division + remainder rotation — sort members by ID, start offset = `hash(expenseId) % n`, hand out 1 minor unit each until remainder exhausted.
- exact: must sum to amount (validate).
- percent: integer basis points (10000 = 100%), same remainder rule.
- shares/adjustment: weights → proportional; adjustments applied then residual split equally.
- itemized: per-member item subtotals; shared items split equally among claimers (remainder rule); tax/tip/service/discount prorated by subtotal ratio; unclaimed items block finalization.
**Invariant (property-tested):** `Σ shares === amount` for all inputs.

### 3.2 Simplify debts
`simplify(pairwiseBalances) → transfers[]` — per currency: net each member, greedy match max debtor ↔ max creditor. **Invariants:** transfers ≤ n−1; every member's net position unchanged; deterministic order. Presentation layer only (ADR-009).

### 3.3 Settlement application
Allocations reduce specific expense receivables; unallocated amount applies oldest-expense-first between the pair. Balance views subtract `confirmed + auto_confirmed` settlements; `initiated` shows as "pending" (counted in an "if confirmed" preview, not the headline number).

---

## 4. Sync protocol (ADR-005)

Client SQLite tables mirror server + `pending_mutations(id UUID, kind, payload JSONB, created_at, attempts)`.

1. Every user action → apply optimistically to SQLite → enqueue mutation (UUID = idempotency key).
2. Sync loop (on connectivity/foreground/push): POST batch to `/sync` edge function → server applies in order, upserting by `client_mutation_id` (replay-safe), returns authoritative rows + a per-group `sync_cursor` (monotonic `updated_seq`).
3. Client pulls changes since cursor (also fed live by Realtime), reconciles SQLite, recomputes local derived balances with `packages/core` (must match server).
4. Conflict: two edits to same expense → both become versions; later server-receipt wins as `current_version_id`; loser surfaced in activity feed ("Asha's edit replaced yours — view/restore").

**Never** trust client-computed shares: server recomputes from `split_params` and rejects mismatches (`SHARE_MISMATCH` → client recomputes/repairs).

---

## 5. UPI settlement flow (ADR-007)

```
Payer taps "Settle ₹420 with Priya"
 → sheet: [Pay via UPI] [Paid in cash] [Bank/other] + optional expense allocations UI
 → UPI: build upi://pay?pa=priya@okaxis&pn=Priya&am=420.00&cu=INR&tn=Baaki%20Goa%20trip
   (validate VPA format; if Priya has no VPA → prompt her via push to add, or show QR fallback)
 → Linking.openURL → payer's UPI app chooser → payer returns
 → "Did the payment go through?" [Yes → settlement initiated] [No/cancel]
 → Priya gets push: "Madan says he paid you ₹420 — confirm?" [Confirm → confirmed]
 → No response in 7 days → auto_confirmed (both notified); dispute reopens it
```
Amounts always full precision; `tn` note ≤ UPI limit; iOS: UPI apps installed → same intent works, else show VPA + copy button + QR.

## 6. Receipt AI pipeline (ADR-008)

Edge function `receipt-parse`: input `{storage_path | raw_text, group_id}` → auth check → quota check → image (downscaled ≤1568px) or text → Claude vision call with strict JSON schema →
`{merchant, date, currency, items[{label, qty, unit_price, total, confidence}], subtotal, taxes[{label,amount}], service_charge, tip, discounts[], grand_total, reconciles: bool}` → arithmetic validation (Σ ≈ grand_total, tolerance 1 minor unit; else mark low-confidence lines) → persist to `receipts.parsed`.
Client review screen: editable line items → publish → group members claim items live (Realtime) → finalize creates the itemized expense via §3.1. Prompt must handle Tamil/Hindi/regional scripts and pasted Swiggy/Zomato/WhatsApp text bills. Track per-scan token cost in a `usage_events` table.

## 7. Notifications & email (ADR-010)

### 7.1 Pipeline

```
activity_log INSERT ──(db webhook)──► notify-fanout edge function
   1. classify event → kind (expense_added, you_owe, settlement_initiated,
      settlement_confirm_request, nudge, ghost_claimed, group_invite_accepted, …)
   2. resolve recipients (group members involved) + each profile's
      notification_prefs (per-group overrides > global > defaults)
   3. route per recipient → channels: in-app (always), push (per prefs),
      email (only the kinds listed in 7.3)
   4. write `notifications` row (the in-app inbox is the ledger of record)
   5. dispatch push + email; update statuses
```

Defaults per ADR-010: immediate push only for events **involving me**; everything else folds into a daily group-activity summary (a scheduled function batches unread `notifications` rows). All copy strings centralized in `packages/core/notifications/copy.ts` (en/ta/hi).

### 7.2 App (push) notifications — Expo

- On login + app-start, register `expo_push_token` into `push_tokens` (one row per device; multi-device supported; revoke on logout).
- `notify-fanout` sends via the Expo Push API in batches of ≤100, checks **push receipts** async (a follow-up scheduled run): `DeviceNotRegistered` → revoke token row; transient errors → retry with backoff (max 3).
- Every push carries a `deep_link` (`baaki://group/<id>/expense/<id>` etc., handled by Expo Router linking config) so tapping lands on the exact object.
- Android: notification channels (`money` = high importance for owe/settle/nudge, `activity` = default, `digest` = low); iOS: category identifiers with a "Confirm received" action button directly on settlement-confirm pushes.
- Rate limits: nudges 1/day/pair (enforced in SQL); collapse keys so 5 rapid expenses in one group become one updated notification, not five.

### 7.3 Email — Resend

- **Provider: Resend**, called only from edge functions (`RESEND_API_KEY` in function env, never in the app). Sending domain `mail.baaki.app` with SPF + DKIM + DMARC configured before first send; `From: Baaki <hello@mail.baaki.app>`.
- Templates (React Email components, rendered in the edge function, en/ta/hi):
  1. `otp-login` (if email OTP is enabled as fallback auth)
  2. `settlement-confirm` — "Madan says he paid you ₹420 — confirm?" (action button deep-links into app/web-lite)
  3. `weekly-digest` — net baaki, per-group deltas, pending confirmations
  4. `group-invite` — when a member invites by email address
  5. `export-ready` — signed download link
  6. `account` — security/device events
- Email is **never** used for routine expense activity (that's the Splitwise spam mistake); only the six templates above, each individually unsubscribable via one-click `List-Unsubscribe` + a preferences deep link (transactional `account` mails exempt).
- **Resend webhook** (`email-events` edge function, signature-verified) ingests `delivered/bounced/complained/opened` into `email_events`; hard bounce or complaint → auto-suppress future non-transactional email to that address and flag in profile prefs.
- Idempotency: pass `notification_id` as Resend's idempotency key so retries never double-send; store `resend_email_id` for traceability.

### 7.4 Reminder nudges

User-initiated ("nudge politely") + optional auto-reminders with due dates — both go through the same 7.1 pipeline as `kind: nudge` (push-first; email only if the recipient has no active push token). Always visible to both parties in the activity feed; friendly tone, never collection-agency language.

## 8. Analytics, export, import

- **Analytics (free, basic):** per-group and per-person totals by category/month (SQL views); charts client-side (victory-native). Deeper analytics = premium later (ADR-011).
- **Export:** edge function → JSON (lossless) + CSV (locale-aware, includes settlement detail + receipt URLs) → signed download URL. Free.
- **Splitwise import:** edge function parses Splitwise CSV → preview mapping UI (columns → members; unknown people become ghosts) → transactional insert as versioned expenses tagged `imported`.

## 9. Screens (mobile)

Onboarding (phone OTP / Google / Apple / "continue as guest") · Home (groups + net baaki headline) · Group (balances, activity, FAB: add expense / scan bill / settle) · Add-expense (calculator built into amount field — 955-vote fix; draft autosave) · Receipt review & claim · Settle sheet (+ allocations) · Simplify view ("who pays whom") · Member profile (VPA, prefs) · Invite/share · Settings (export, import, notifications, lock) · Activity feed. Guest web-lite: group view + add expense + join CTA.

---

## 10. Milestones & acceptance criteria

**M0 — Foundations (repo, CI, schema)**
Monorepo + Expo app boots; Supabase local dev; **Prisma schema + migrations** for §2 (RLS/triggers/views as customized migration SQL per §2.0); `packages/core` money/split/simplify with property tests green in CI.
✓ CI runs typecheck + unit + property + RLS tests + `prisma migrate diff` drift check; migrations apply cleanly to a fresh database; balances-Σ-zero invariant test exists and passes.

**M1 — Core ledger (online)**
Auth (OTP/Google/Apple), create group, add/edit/soft-delete expenses (all split types, multi-payer), balances + simplify view, settle-up recording (cash) with partial allocations, activity feed, realtime updates between two devices.
✓ Two devices see each other's expense <2s; edit history visible; deleted expense restorable; all money invariants hold on server-side recomputation.

**M2 — Offline-first sync**
SQLite mirror + mutation queue + `/sync` edge function + conflict versioning + draft autosave.
✓ Airplane-mode: add 10 expenses on 2 devices, reconnect → identical balances, no dupes (idempotency), conflicting edit surfaces in feed. Kill app mid-entry → draft restored.

**M3 — Growth loop: invites, ghosts, guest web-lite, import**
Invite links, ghost members, claim/merge flow, anonymous→full account upgrade, Splitwise CSV import.
✓ Guest opens link in browser, adds an expense with no install; later installs, claims ghost, history intact; Splitwise CSV round-trips into correct balances.

**M4 — UPI settlement + notifications**
VPA profiles, UPI intent flow + confirm state machine + auto-confirm job, nudges; full §7 pipeline: push-token registry, notify-fanout with receipts/retries, in-app inbox, Resend templates + webhook ingestion + suppression list.
✓ End-to-end: initiate UPI settle → payee push with Confirm action → balances update; 7-day auto-confirm fires; notification prefs respected in fanout tests; settlement-confirm email renders and delivers via Resend sandbox; bounce webhook suppresses future sends; no double-send on retried fanout (idempotency).

**M5 — AI receipts + analytics + export**
receipt-parse pipeline, review/claim UX, quotas + usage metering, category charts, JSON/CSV export.
✓ English + Tamil + pasted-text bills parse and reconcile; 4 users claim items concurrently; itemized expense math exact; export re-imports losslessly.

**Out of scope v1:** money custody/wallet, SMS auto-import, open banking, iOS widgets, web full app, public API, interest/loan mode (backlog).

---

## 11. Non-functional requirements

- Cold start < 2s to usable local data; all list screens virtualized.
- Server recompute of any group's balances < 200ms p95 at 10k expenses/group.
- Crash-free sessions > 99.5% (Sentry); sync queue survives forced kill.
- Accessibility: dynamic type, screen-reader labels on money values ("you are owed four hundred twenty rupees").
- i18n scaffolding from day one: en + ta + hi string files; all money/date formatting locale-aware.
- Secrets only in edge-function env (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, Prisma `DATABASE_URL`/`DIRECT_URL`); no LLM or service keys in the app bundle.

## 12. How to instruct Claude Code

Paste both files into the repo root, then per milestone:

> Read `baaki-adr.md` and `baaki-tdr.md`. Implement Milestone M<n> exactly as specified. ADRs are binding constraints — if a conflict or ambiguity arises, stop and ask rather than deviating. Write the tests listed in the milestone's acceptance criteria first, then make them pass. Do not begin the next milestone.

Recommended session order: M0 → M1 → M2 → M3 → M4 → M5, one session (or worktree) per milestone, with a review of invariant tests before advancing.
