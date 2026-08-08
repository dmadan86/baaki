# Baaki — Technical Design Record (TDR)

**Companion to:** `baaki-adr.md` (the ADRs are binding; this TDR describes _how_ to build them).
**Audience:** Claude Code (or any engineer) implementing the product. Build in milestone order (§10); each milestone has acceptance criteria.
**Amendments:** §12 lists everything that shipped which this document originally did not say, and why. Read it before trusting a section to be complete.

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
│  (served page + anon auth)  │        │      sync, expense-write,        │
└─────────────────────────────┘        │      invite-mint, invite-accept, │
                                       │      receipt-parse (LLM),        │
        Claude API (vision) ◄──────────│      export-data, fx-rate,       │
        Expo Push / Resend  ◄──────────│      notify-fanout               │
                                       └──────────────────────────────────┘
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

**Trip reminders (amendment A3).** A group with trip dates gets at most two scheduled nudges a day while the trip is running — "add today's expenses" — through the same §7.1 pipeline as `kind: nudge`, and nothing after it ends. Same rate limit as every other nudge, and the same tone rule: a reminder, never a demand.

## 6. Receipt AI pipeline (ADR-008)

Edge function `receipt-parse`: input `{storage_path | raw_text, group_id}` → auth check → quota check → image (downscaled ≤1568px) or text → Claude vision call with strict JSON schema →
`{merchant, date, currency, items[{label, qty, unit_price, total, confidence}], subtotal, taxes[{label,amount}], service_charge, tip, discounts[], grand_total, reconciles: bool}` → arithmetic validation (Σ ≈ grand_total, tolerance 1 minor unit; else mark low-confidence lines) → persist to `receipts.parsed`.
Client review screen: editable line items → publish → group members claim items live (Realtime) → finalize creates the itemized expense via §3.1. Prompt must handle Tamil/Hindi/regional scripts and pasted Swiggy/Zomato/WhatsApp text bills. Track per-scan token cost in a `usage_events` table.

**On-device OCR first (amendment A5).** The phone reads the bill with ML Kit and sends `raw_text`; the photograph only leaves the device when that fails. About a tenth the cost per scan, and the image stays on the phone whenever it can be read there. The platform document scanner (`VNDocumentCameraViewController` / ML Kit) crops and de-skews the page first, because a photograph taken at a table is at an angle on a patterned cloth.

**Scanning from add-expense (amendment A6).** The camera is on the add-expense screen as well as on the itemize screen. From there a scan fills in the **total and the merchant** and stays put — most bills are split some way that has nothing to do with what each line cost — and offers "split by item instead" when it read line items. The parsed receipt is handed over for ten minutes so nobody photographs the same bill twice (a scan is metered, ADR-011).

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

- **Analytics (free, basic):** per-group and per-person totals by category/month, exposed as `baaki_group_spending(group_id)` — a function, not a view (amendment A7) — at the finest grain: per member, per category, per month, per currency. Currencies are never summed or converted; shares are never re-divided; only current versions of live expenses count. Charts are drawn client-side from plain views, not victory-native (amendment A8). Deeper analytics = premium later (ADR-011).
- **Categories (amendment A9):** ten fixed categories, guessed from the description with an India-first keyword table and shown as a chip the person can change. Nothing blocks saving; "other" is a real answer.
- **Export:** edge function → JSON (lossless) + CSV (locale-aware, includes settlement detail + receipt URLs) → signed download URL. Free.
- **Splitwise import:** parses Splitwise CSV → preview mapping UI (names → members; unknown people become ghosts) → transactional insert as versioned expenses tagged `imported`. Implemented as the RPC `baaki_import_splitwise`, not an edge function (amendment A4).
- **Baaki import (amendment A10):** the same screen reads our own JSON export back into a new group through `baaki_import_ledger`, expenses _and_ settlements, reproducing every balance to the paisa. Ids, edit history and settlement allocations do not come across; none of them changes what anybody owes, and the screen says so before the import runs.
- **Bank SMS import (amendment A2):** card and UPI debit messages already on the phone are parsed locally into proposed expenses, which are only written once somebody confirms them. This contradicts the v1 out-of-scope list in §10 and was built on request; see A2 for what is and is not covered.

## 9. Screens (mobile)

Onboarding (phone OTP / Google / Apple / "continue as guest") · Home (groups + net baaki headline) · Group (balances, activity, FAB: add expense / scan bill / settle) · Add-expense (calculator built into amount field — 955-vote fix; draft autosave) · Receipt review & claim · Settle sheet (+ allocations) · Simplify view ("who pays whom") · Member profile (VPA, prefs) · Invite/share · Settings (export, import, notifications, lock) · Activity feed. Guest web-lite: group view + add expense + join CTA.

Also shipped, and not in the list above:

- **Add-expense**: a dictation button on the note (amendment A1), the split-type fields themselves — shares and percentages are typed, with each person's rupee amount shown as they are (this was specified in §3.1 but had no UI until later) — a category chip row (A9), and the bill scanner (A6).
- **Spending** — one screen per group: what each category cost, month by month, for the group or for you (§8).
- **Friends** — who owes you and who you owe across every group, and browsing the phone's contacts to add somebody (A11).
- **Expense disputes** (A12) — disagreeing with an expense from its own screen, visible to everybody in the group rather than settled in a side conversation.
- **A version gate** (A13) — the app tells people a new version is out, and refuses to run a build that must not run.
- **A reduce-motion switch** and a first-run tour of what Baaki is, before it asks for anything.

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

_Status (2026-08-08):_ **complete.** Every clause has a live run behind it, all against the deployed project: `e2e/m3-web-lite.mjs` 19/19 for the browser half, including that a stranger holding the same anon key sees nothing and that the guest keeps the same account after adding credentials; `e2e/m3-invites.mjs` 20/20 for preview → join → claim, with the ghost's balances carried over unchanged and the same ghost refused to a second claimant; `e2e/m3-splitwise-import.mjs` 17/17 for the CSV, checked at `group_balances` rather than at the parser, and asserting the import is one transaction — a half-finished one still adds up, it is simply a smaller group that never existed.

**M4 — UPI settlement + notifications**
VPA profiles, UPI intent flow + confirm state machine + auto-confirm job, nudges; full §7 pipeline: push-token registry, notify-fanout with receipts/retries, in-app inbox, Resend templates + webhook ingestion + suppression list.
✓ End-to-end: initiate UPI settle → payee push with Confirm action → balances update; 7-day auto-confirm fires; notification prefs respected in fanout tests; settlement-confirm email renders and delivers via Resend sandbox; bounce webhook suppresses future sends; no double-send on retried fanout (idempotency).

_Status (2026-08-08):_ **not complete, and the shortfall is bigger than it looks.**

What is built and tested against a real database: the settle/confirm state machine, the 7-day auto-confirm job (`m4-auto-confirm.test.ts`), the trip nudges (`m4-trip-nudges.test.ts`), expense disputes (`m4-expense-disputes.test.ts`), and the push fan-out with its claim/finish protocol — `m4-push-fanout.test.ts` covers idempotency directly ("never hands the same one over twice"), language, stale rows, revoked devices and limits.

What a live run proves: `e2e/m4-live.mjs` 16/16 against the deployed project. Read what it checks, though — trip dates, the dispute flow, and that `notify-fanout`, `baaki_auto_confirm_settlements`, `baaki_trip_nudges`, `baaki_claim_push_notifications` and `baaki_finish_push` all refuse a merely signed-in caller. It is a check that the deployed surface has the migrations and the grants, which is what its own header says it is. **It does not touch the acceptance criterion above.**

What is missing:

- **The whole Resend half is unbuilt.** There is no email edge function, no webhook handler and no suppression list — the only trace of it anywhere is a `resend_email_id` column in `notifications` from the M0 schema. So "settlement-confirm email renders and delivers via Resend sandbox" and "bounce webhook suppresses future sends" are not failing tests; they are features with no code.
- **No push has ever reached a device.** The pipeline is built and the fan-out is tested, but FCM and APNs credentials are a console job nobody has done (amendment A15, and README "Turning on push"). Without them a token cannot be issued, so "payee push with Confirm action → balances update" has never run end to end.

Until both are addressed M4 is the largest incomplete block in the project, and the ✓ above should be read as the target rather than the state.

**M5 — AI receipts + analytics + export**
receipt-parse pipeline, review/claim UX, quotas + usage metering, category charts, JSON/CSV export.
✓ English + Tamil + pasted-text bills parse and reconcile; 4 users claim items concurrently; itemized expense math exact; export re-imports losslessly.

_Status (2026-08-08):_ all five parts are built. Bills parsing and reconciling is proved against the deployed function by `e2e/m5-receipts.mjs`; itemized expense maths is a property test in `packages/core`; the export/import round trip is proved balance-for-balance against a real database in `packages/db/test/m5-import-export.test.ts`.

**Four users claiming items concurrently is proved**, by `e2e/m5-claims.mjs` against the deployed project — 27/27 on 2026-08-08. Four signed-in sessions, each having joined through the real invite flow, claiming concurrently through `baaki_set_item_claim`; every claim attributed to the caller rather than to whoever the request named. The run also pins the things the criterion implies and nothing tested: the same claim raced four times converges on one row, `NOT_YOURS` refuses claiming for somebody who has the app, `NOT_A_MEMBER` refuses an outsider, the claims table answers a direct client write with `permission denied`, `ALREADY_CLAIMING` freezes the lines once claiming starts, and all four see each other's taps rather than only their own.

**M5 is complete.** All four parts of the criterion now have a proof behind them.

What that harness replaces is worth recording, because it is the reason this went unnoticed for a milestone. `m5-receipts.mjs` carried a check called "four people claim items concurrently without stepping on each other", and it inserted into `receipt_item_claims` through the **service role** — bypassing RLS, bypassing the grants, and never calling `baaki_set_item_claim`, the function that decides whose claim a claim is. That table has INSERT, UPDATE and DELETE revoked from `anon` and `authenticated`, so the check drove a door no phone can open, and what it demonstrated was that Postgres accepts concurrent inserts from a superuser. **It has been deleted**, rather than left in place to be read as evidence of something it never tested.

The itemized arithmetic that sat downstream of it stays in `m5-receipts.mjs`, over a claim map written in the file: whether four people can _make_ those claims is `m5-claims.mjs`'s subject, and the sum is the same sum wherever the map came from. With the service-role writes gone, `m5-receipts.mjs` now needs only `ANON_KEY` — everything it does is what an ordinary signed-in phone can do.

**Out of scope v1:** money custody/wallet, ~~SMS auto-import~~ (built anyway — amendment A2), open banking, iOS widgets, web full app, public API, interest/loan mode (backlog).

---

## 11. Non-functional requirements

- Cold start < 2s to usable local data; all list screens virtualized.
- Server recompute of any group's balances < 200ms p95 at 10k expenses/group.
- Crash-free sessions > 99.5% (Sentry); sync queue survives forced kill.
- Accessibility: dynamic type, screen-reader labels on money values ("you are owed four hundred twenty rupees").
- i18n scaffolding from day one: en + ta + hi string files; all money/date formatting locale-aware.
- Secrets only in edge-function env (`ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, Prisma `DATABASE_URL`/`DIRECT_URL`); no LLM or service keys in the app bundle.

## 12. Amendments

Everything below shipped and this document did not say so. Each was built deliberately — most of them on request — and each is recorded here rather than left as a difference between the spec and the repository that the next person has to discover.

The rule the ADRs set is unchanged: **a deviation is written down, not hidden.** Where an amendment contradicts something above, the amendment wins and the section it touches has been edited to match.

| #   | Amendment                                                                                                                                                                                                                                                                                                                                                                        | Where   | Why it deviates                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | **Voice note on an expense.** Hold the mic on the description and speak it; member names are handed to the recogniser as hints, because a general model guesses at Indian names and gets them wrong.                                                                                                                                                                             | §9      | §9 never mentioned dictation. Nothing else changes: it fills the same text field somebody would have typed into.                                                                                                                                                                                                                               |
| A2  | **Bank SMS import.** Card and UPI debit messages already on the phone are parsed on the device into proposed expenses; nothing is written until somebody confirms one. Messages never leave the phone.                                                                                                                                                                           | §8, §10 | §10 lists "SMS auto-import" as **out of scope for v1**. Built on request. The word doing the work is _auto_: nothing here imports by itself, and the out-of-scope line is struck rather than quietly ignored.                                                                                                                                  |
| A3  | **Trip reminder nudges.** A group with trip dates gets at most two nudges a day while the trip runs, and none after it ends.                                                                                                                                                                                                                                                     | §5, §7  | §7.4 had user-initiated nudges and due-date reminders; a trip is neither. Same pipeline, same rate limit, same tone.                                                                                                                                                                                                                           |
| A4  | **Splitwise import is an RPC, not an edge function.** `baaki_import_splitwise` (now a wrapper over `baaki_import_ledger`).                                                                                                                                                                                                                                                       | §8, §10 | §8 said edge function. A function body is one transaction; an edge function looping over REST calls is not, and somebody moving four years of history cannot tell a half-finished import from a complete one — the balances add up either way.                                                                                                 |
| A5  | **On-device OCR before the model.** ML Kit reads the bill and `raw_text` is sent; the image only leaves the phone when that fails.                                                                                                                                                                                                                                               | §6      | §6 assumed the image goes to the model. About a tenth the cost per scan, and the photograph stays on the device whenever it can be read there.                                                                                                                                                                                                 |
| A6  | **Scan the bill from add-expense.** Fills the total and the merchant, stays put, and offers "split by item instead" if it read line items.                                                                                                                                                                                                                                       | §6, §9  | §9 put the camera only on the group FAB and the itemize screen. Most bills are split some way that has nothing to do with what each line cost.                                                                                                                                                                                                 |
| A7  | **Analytics is a function, not a SQL view.** `baaki_group_spending(group_id)`.                                                                                                                                                                                                                                                                                                   | §8      | Prisma owns the datamodel and `prisma migrate diff` is a merge gate (ADR-014). A view is an object Prisma has an opinion about; a function is not, and every other derived read here is already one.                                                                                                                                           |
| A8  | **Charts without victory-native.** Bars and columns drawn with plain views.                                                                                                                                                                                                                                                                                                      | §8      | victory-native renders through Skia now: another native module, another prebuild, another thing that can fail at launch — to animate a list of bars. Plain views also survive the web export.                                                                                                                                                  |
| A9  | **Expense categories are guessed, not asked for.** Ten fixed categories, an India-first keyword table, one tap to change.                                                                                                                                                                                                                                                        | §8, §9  | The category column existed from M0 and nothing filled it. A menu between somebody and saving a dinner is how a column stays empty, and an empty column is a chart nobody can draw.                                                                                                                                                            |
| A10 | **A Baaki export can be imported back.** `baaki_import_ledger` takes expenses and settlements; balances return to the paisa.                                                                                                                                                                                                                                                     | §8      | §8 specified export and Splitwise import, but never reading our own file — which is exactly what M5's "export re-imports losslessly" asks somebody to be able to do.                                                                                                                                                                           |
| A11 | **Friends tab and contact browsing.** Who owes you and who you owe across every group; add somebody from the phone's contacts. Contacts stay on the phone — only the person tapped is sent.                                                                                                                                                                                      | §9      | §9 had no such screen. Ghosts are never merged across groups by name: a name is not proof that two records are one human.                                                                                                                                                                                                                      |
| A12 | **Expense disputes.** Disagree with an expense from its own screen; the disagreement is visible to the whole group.                                                                                                                                                                                                                                                              | §9      | Nothing in the spec covered disagreement. A dispute settled in a side conversation is one the ledger never learns about.                                                                                                                                                                                                                       |
| A13 | **Version gate.** `app_releases` tells people a new version exists and refuses to run a build that must not run.                                                                                                                                                                                                                                                                 | §11     | Not in the spec at all. A client that computes money must be stoppable when it computes it wrongly.                                                                                                                                                                                                                                            |
| A14 | **Windows/pnpm native build fixes.** A config plugin moves the CMake staging directory; `packageExtensions` supplies a dependency a third-party config plugin forgets to declare.                                                                                                                                                                                                | §1      | Environment, not product — recorded because the failure it prevents (`ninja: manifest 'build.ninja' still dirty after 100 tries`, blaming an untouched dependency) costs about ten minutes each time to rediscover.                                                                                                                            |
| A15 | **FCM credentials are a console job, and the repo now says so instead of failing quietly.** `app.config.ts` resolves `android.googleServicesFile` from an EAS file secret or a local copy and omits the key when there is neither; `refreshPushToken` returns a reason rather than throwing; the fanout tells a wrong FCM key apart from a country with its phones switched off. | §7, §11 | §7 described the delivery pipeline and never said what makes a push token exist in the first place. Without `google-services.json` in the binary, Android push cannot work however correct everything above it is — and each symptom of that (a token call rejecting at launch, tickets erroring one by one) reads as something else entirely. |

| A16 | **Ledger tables are read-only to clients; every write goes through an RPC.** Direct INSERT/UPDATE on `settlements`, `activity_log`, `expenses`, `expense_versions`, `expense_shares`, `expense_payers` and `settlement_allocations` is revoked; `baaki_apply_expense` checks the caller, not only the ids it is handed; a trigger pins `role`, `profile_id` and `group_id` on a membership; `_prisma_migrations` gets RLS; the unused `app_metadata.baaki_groups` branch of `is_group_member` is gone. | §2, §11 | §2 specified membership-scoped RLS and got it — but membership answers "may you touch this group", and seven policies used it to answer "is this row about you". A member could insert a settlement already marked confirmed and erase their own debt; a stranger could write an expense into a group they had never joined. Both were executed against a real database before the fix and are kept as tests in `packages/db/test/security-hardening.test.ts`. |

Two rules that came out of the same period and are binding on new work:

- **A native module is reached through a lazy `require` behind a non-throwing check.** expo-router loads every route file to build the route tree, so a module that throws while its own JS is evaluated does not disable a button — it stops the app from launching, with a red screen naming a screen nobody opened. `TurboModuleRegistry.get` (not `getEnforcing`) and `globalThis.expo.modules` are the two non-throwing forms. Nothing on a dev machine catches this: bundle, typecheck, lint, tests and `expo-doctor` all pass while the app is unlaunchable.
- **Money is converted in decimal, never in floating point.** `0.29 * 10000` is `2899.9999999999995`, and that is one paisa.
- **`is_group_member()` is not an authorization check on a row.** It answers "may you touch this group". A policy that also needs "is this row about you" — is this settlement yours to confirm, is this the author who wrote it, is this your membership row — must ask that separately. Every finding in A16 was this one substitution. And a table nobody's client writes should not be writable by anybody's client: Supabase grants `ALL` on `public` to `anon` and `authenticated` by default, so the privilege exists until it is explicitly revoked, whether or not a policy is ever written for it.
- **`REVOKE ... FROM anon, authenticated` on a function does nothing on its own.** Postgres grants `EXECUTE` to `PUBLIC`, and those roles keep reaching it that way while the statement reports success. It is `FROM PUBLIC`, and then `service_role` needs it granted back.

## 13. How to instruct Claude Code

Paste both files into the repo root, then per milestone:

> Read `baaki-adr.md` and `baaki-tdr.md`. Implement Milestone M<n> exactly as specified. ADRs are binding constraints — if a conflict or ambiguity arises, stop and ask rather than deviating. Write the tests listed in the milestone's acceptance criteria first, then make them pass. Do not begin the next milestone.

Recommended session order: M0 → M1 → M2 → M3 → M4 → M5, one session (or worktree) per milestone, with a review of invariant tests before advancing.

All six milestones are now built. Work beyond them is asked for directly rather than read off a milestone, and the instruction that matters most is the one §12 exists to enforce: **when the work departs from this document, amend the document in the same change.** An undocumented deviation is a thing the next person has to find by reading the code and guessing whether it was deliberate.
