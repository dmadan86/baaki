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

- **Provider: Resend**, called only from edge functions (`RESEND_API_KEY` in function env, never in the app). Sending domain ~~`mail.baaki.app`~~ **`mail.dmadan.com`** (amendment A28 — `baaki.app` is not a domain this project owns) with SPF + DKIM + DMARC configured before first send; `From: Baaki <hello@mail.dmadan.com>`, overridable with `EMAIL_FROM`.
- Templates (React Email components, rendered in the edge function, en/ta/hi):
  1. `otp-login` (if email OTP is enabled as fallback auth)
  2. `settlement-confirm` — "Madan says he paid you ₹420 — confirm?" (action button deep-links into app/web-lite)
  3. `weekly-digest` — net baaki, per-group deltas, pending confirmations
  4. `group-invite` — when a member invites by email address
  5. `export-ready` — signed download link
  6. `account` — security/device events
- Email is **never** used for routine expense activity (that's the Splitwise spam mistake); only the six templates above, each individually unsubscribable via one-click `List-Unsubscribe` + a preferences deep link (transactional `account` mails exempt). Enforced twice on purpose: `TEMPLATE_FOR_KIND` in `@waves/core` and the `kind IN (…)` list in `baaki_claim_email_notifications`, so widening it is a change somebody has to make in SQL and mean.
- **Resend webhook** (`email-events` edge function, signature-verified) ingests `delivered/bounced/complained/opened` into `email_events`; hard bounce or complaint → auto-suppress future non-transactional email to that address and flag in profile prefs.
- Idempotency: pass `notification_id` as Resend's idempotency key so retries never double-send; store `resend_email_id` for traceability.

### 7.4 Reminder nudges

User-initiated ("nudge politely") + optional auto-reminders with due dates — both go through the same 7.1 pipeline as `kind: nudge` (push-first; email only if the recipient has no active push token). Always visible to both parties in the activity feed; friendly tone, never collection-agency language.

## 8. Analytics, export, import

- **Analytics (free, basic):** per-group and per-person totals by category/month, exposed as `baaki_group_spending(group_id)` — a function, not a view (amendment A7) — at the finest grain: per member, per category, per month, per currency. Currencies are never summed or converted; shares are never re-divided; only current versions of live expenses count. Charts are drawn client-side from plain views, not victory-native (amendment A8) — in the app; the operator console draws with ECharts instead (amendment A31). Deeper analytics = premium later (ADR-011).
- **Categories (amendment A9; extended by A42):** ten built-in categories, guessed from the description with an India-first keyword table and shown as a chip the person can change. Nothing blocks saving; "other" is a real answer. The ten are no longer the whole set — **A42** lets a person add their own tags, and hide or reorder the built-ins, from a personal catalog.
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
- **Archived groups** (A35) — the archived-groups list and one-tap unarchive, reached from the dashboard overflow menu; the read side of an archive that until now only wrote.
- **AI keys** (A40) — "Bring your own key": paste a model API key (OpenAI/Anthropic/Moonshot) held on the device only, in its own "AI" section of the settings screen; the vault and access rule the model features are built on.

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

- ~~**The whole Resend half is unbuilt.**~~ Built on 2026-08-09 (amendment A28): the claim/finish protocol, the suppression list, the sender inside `notify-fanout`, the signature-verified `email-events` webhook and a one-click `email-unsubscribe`. 40 tests in `m4-email.test.ts` and 39 in `packages/core/test/email.test.ts`, including the webhook signature against Svix’s published vector. **No email has been sent.** Every one of those tests stops at the edge of the network: what is proved is that the right rows are claimed once, that a bounce stops the next send, and that nobody signed in can reach any of it. "Renders and delivers via Resend sandbox" needs a verified sending domain and a deployed function, and neither has happened.
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
- i18n scaffolding from day one: en + ta + hi + **ar** string files; all money/date formatting locale-aware.
  Arabic is more than a fourth column: the layout mirrors, and React Native decides direction natively **at launch**,
  so a language change needs a restart and the app says so rather than half-mirroring. Icons are content, not layout —
  every arrow goes through `directionalIcon`, or "next" points backwards on a mirrored screen.
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
| A11 | **Friends tab and contact browsing.** Who owes you and who you owe across every group; add somebody from the phone's contacts. Contacts stay on the phone — only the person tapped is sent.                                                                                                                                                                                      | §9      | §9 had no such screen. Ghosts are never merged across groups by name: a name is not proof that two records are one human. (A38 later lets a viewer fold them on their own Friends list — in front of the ledger, never inside it; the rule here is about the ledger and stays.)                                                                |
| A12 | **Expense disputes.** Disagree with an expense from its own screen; the disagreement is visible to the whole group.                                                                                                                                                                                                                                                              | §9      | Nothing in the spec covered disagreement. A dispute settled in a side conversation is one the ledger never learns about.                                                                                                                                                                                                                       |
| A13 | **Version gate.** `app_releases` tells people a new version exists and refuses to run a build that must not run.                                                                                                                                                                                                                                                                 | §11     | Not in the spec at all. A client that computes money must be stoppable when it computes it wrongly.                                                                                                                                                                                                                                            |
| A14 | **Windows/pnpm native build fixes.** A config plugin moves the CMake staging directory; `packageExtensions` supplies a dependency a third-party config plugin forgets to declare.                                                                                                                                                                                                | §1      | Environment, not product — recorded because the failure it prevents (`ninja: manifest 'build.ninja' still dirty after 100 tries`, blaming an untouched dependency) costs about ten minutes each time to rediscover.                                                                                                                            |
| A15 | **FCM credentials are a console job, and the repo now says so instead of failing quietly.** `app.config.ts` resolves `android.googleServicesFile` from an EAS file secret or a local copy and omits the key when there is neither; `refreshPushToken` returns a reason rather than throwing; the fanout tells a wrong FCM key apart from a country with its phones switched off. | §7, §11 | §7 described the delivery pipeline and never said what makes a push token exist in the first place. Without `google-services.json` in the binary, Android push cannot work however correct everything above it is — and each symptom of that (a token call rejecting at launch, tickets erroring one by one) reads as something else entirely. |

| A16 | **Ledger tables are read-only to clients; every write goes through an RPC.** Direct INSERT/UPDATE on `settlements`, `activity_log`, `expenses`, `expense_versions`, `expense_shares`, `expense_payers` and `settlement_allocations` is revoked; `baaki_apply_expense` checks the caller, not only the ids it is handed; a trigger pins `role`, `profile_id` and `group_id` on a membership; `_prisma_migrations` gets RLS; the unused `app_metadata.baaki_groups` branch of `is_group_member` is gone. | §2, §11 | §2 specified membership-scoped RLS and got it — but membership answers "may you touch this group", and seven policies used it to answer "is this row about you". A member could insert a settlement already marked confirmed and erase their own debt; a stranger could write an expense into a group they had never joined. Both were executed against a real database before the fix and are kept as tests in `packages/db/test/security-hardening.test.ts`. |

| A17 | **A private operator console.** `apps/admin` — a Next.js app on Vercel reading six `baaki_admin_*` aggregate functions. Not one of them returns a description, a note, a display name, a payment handle or a profile id — the user-admin half added later (amendment A32) is the deliberate exception, and says so. | §8, §11 | §8 described analytics somebody sees about their own spending. This is the other direction and the spec had no word for it. The functions are revoked from `PUBLIC`, `anon` and `authenticated` and granted to `service_role` alone — without that REVOKE any anonymous guest could read the whole business through the anon key that ships inside the mobile binary. `packages/db/test/adminAnalytics.test.ts` fails if it regresses. |
| A18 | **Entitlements, subscriptions and group passes.** A plan resolves per person and per group; the receipt scan quota reads it rather than a constant. | §6, §11 | ADR-011 set the guardrails — free forever for the ledger, paid only for what costs money — and nothing said where a plan is stored or who resolves it. The quota was a hardcoded 20 in the edge function and a second hardcoded 20 in Postgres, which is two places to forget when somebody pays. |
| A19 | **Feature flags with bucketed rollout.** A flag names a percentage and a stable hash of the profile decides who is in it. | §11 | Not in the spec. A version gate (A13) can stop a build; it cannot turn one feature off for nine people out of ten while it is watched. |
| A20 | **Promotion codes, and a screen to type one into.** `baaki_redeem_promo` is SECURITY DEFINER and the only writer of a grant. | §11 | Not in the spec. A paywall a client can insert its own row into is a paywall with a door in the back. Every refusal — mistyped, expired, used up, already redeemed — gets its own sentence, because one "that did not work" sends somebody to check three different things. |
| A21 | **In-app campaigns.** A message with a window and an audience, shown once, with impressions recorded. | §7, §11 | §7 covered push and digest email to individuals about their own ledger. A campaign is neither — it is the product talking to everybody, and it is deliberately inside the lock screen: a promotion is not a reason to show somebody's phone anything before they have unlocked it. The broadcast-by-email half is now built too (2026-08-10): the console sends a campaign to its targeted cohort through the `campaign-broadcast` edge function, which reuses M4's address lookup, suppression list and `email-events` webhook rather than growing a parallel one. The one rule it adds is the one the whole feature turns on — the holdout is never mailed, checked with the same `baaki_campaign_cohort` the in-app half uses so the two arms cannot drift. `baaki_claim_campaign_emails` is the claim (an INSERT whose UNIQUE is the lock against a double-send), and 21 tests across `campaignBroadcast.test.ts` and `campaignEmail.test.ts` prove who is claimed and what a mail carries. Like the rest of M4 it has never sent an email: that waits on a verified Resend domain and a deployed function. |
| A22 | **Feedback, and account erasure that actually erases.** `baaki_submit_feedback`; erasure removes the ledger rows a person owns and the sign-in behind them. | §9, §11 | Neither was in §9. ADR-012 covers getting data out and says nothing about getting rid of it. Erasure has two halves that need two keys: `baaki_delete_my_account` anonymises the memberships and deletes the profile as the caller, and the `account-delete` edge function then removes the `auth.users` row with the service key no client holds. Data first, identity second — a run that stops between the two has erased the data and left a sign-in that reaches nothing, which is recoverable because the RPC is idempotent and the client simply calls again; the reverse order would strand the ledger rows. (Previously a known gap: the RPC ran and the auth identity survived it. The edge function is now built — `apps/mobile` calls it in place of the RPC.) |
| A23 | **A trip plan that is not money.** Plan items sit on a day, may carry a planned amount, and can later be linked to the expense they turned into. | §2, §9 | Not in the spec. Deliberately not an expense with a flag: an expense that has not happened yet would show up in balances, exports and simplification, and be wrong in all three. |
| A24 | **Splitting a scanned bill by line item, together.** Members claim the lines they had; the split follows the claims. | §6, §9 | §6 stopped at itemization — the model reads lines and somebody accepts them. Who ate which line is the half that makes an itemized bill worth scanning. |
| A25 | **Ghost claims go through the organiser, which ADR-006 always said.** A claim is a row, an admin approves or declines it, and only approval moves the membership. | §2, §9 | Not a deviation — a correction. ADR-006 says "organizer confirms" and until this shipped, opening a link and tapping a ghost's name took its whole history immediately, with no one asked. Anybody holding the link could become the person owed the money. The move is guarded by `profile_id IS NULL AND left_at IS NULL`, so two people racing for one ghost cannot both win it. |
| A26 | **Every edge function is rate limited.** Fixed windows counted in Postgres by `baaki_rate_limit`, one bucket per function, `service_role` only. | §11 | §11 named the secrets and said nothing about how often anybody may call anything. `invite-accept` is why it exists: in preview mode it answers before any identity is required, which makes it an oracle for guessing invite tokens. Counting in Postgres and not in the isolate because Supabase runs as many isolates as it likes and discards them between requests — an in-memory limiter there limits roughly nothing, and passes a single-instance test while doing it. Fails open: the only way the count cannot be taken is the database being unreachable, and every one of these functions is about to talk to that same database anyway. |
| A27 | **Payment rails beyond UPI.** PayID (Australia) and PayPal (everywhere), on top of the India-first rails and country column. | §5 | §5 is UPI end to end, and ADR-007's rule — Baaki never moves money — is unchanged: these are the same deep-link-and-confirm dance with a different app on the other end. Named in a CHECK constraint rather than an enum, so opening a market is one migration and no type surgery. |
| A28 | **The email half, on `mail.dmadan.com` and with three templates rather than six.** Claim → render → send inside `notify-fanout`, a Svix-verified `email-events` webhook, an `email_suppressions` list, and an RFC 8058 one-click `email-unsubscribe`. | §7.3 | Three departures from §7.3, all deliberate. **The domain** is `mail.dmadan.com`, not `mail.baaki.app` — `baaki.app` is not a domain this project owns, and a `From:` on an unverified domain is refused outright rather than delivered badly. **Three templates, not six.** `otp-login` is Supabase Auth's own mail; `group-invite` has no caller because invites are links rather than addresses; `export-ready` has none because export returns a signed URL in the same response. Writing renderers for them now would be three untested paths waiting for a feature. **Not React Email**, which §7.3 asks for: a React renderer in a Deno isolate buys nothing here — the mail is a heading, a paragraph and a button — and the same pure-function-in-`@waves/core` shape as `push.ts` is testable without a mailbox. Added beyond §7.3: `email-unsubscribe`, because §7.3 asks for one-click `List-Unsubscribe` and RFC 8058 means the mailbox POSTs that URL unattended, with no session to authenticate — so the address carries an HMAC, and the endpoint is the second in the app with `verify_jwt = false`. |

| A29 | **A cap on how many devices a free account may use at once.** Two for free, ten for plus; a soft gate at sign-in that never blocks it, "log out other devices" run from the current one, and a devices list showing the last three months. `device_sessions` with `baaki_register_device` / `baaki_list_devices` / `baaki_sign_out_other_devices`. | §11 | Not in the spec. GoTrue's sessions are neither client-queryable nor labelled, so a device is a row the app writes and names itself; "simultaneous" is a fourteen-day seen window; the gate is soft because a paywall that can lock somebody out of their own ledger is worse than a second login. Signing others out is `supabase.auth.signOut({ scope: 'others' })` — no admin key. Built on request; never yet run on a device. |
| A30 | **A contact's public avatar, when they were invited by email.** `baaki_gravatar_url` hashes the address and `baaki_people_i_owe` falls back to it wherever a profile has no photo of its own. | §8, §9 | A11 added the Friends/contacts view and kept contacts on the phone. This sends nothing new: only an md5 of an address the server already stores ever leaves it, `d=404` makes a miss fall back to initials, and there is no client change because the avatar already rendered `avatar_url`. Server-side and best-effort. |
| A31 | **The operator console draws with a chart library.** A dark-rail dashboard — stat cards, a currency-share donut, a thirty-day activity area — with the charts as client components fed serialisable props from the server pages (ECharts). | §8 (A8) | A8's "no chart library" is a decision about the _mobile_ app, where victory-native is a native module that can fail at launch on a device. The console is a Next.js page on Vercel where none of that applies, and it was asked for by name. The mobile app is unchanged; A8 still holds there. |
| A32 | **The console reads and acts on named accounts.** Find a signup by name/email prefix or by country, paginated; see type (guest/free/plus), country, live device count and app version; confirm an email by hand and comp a paid grant. `baaki_admin_users` joins `auth.users` to profiles, subscriptions and `device_sessions`. | §8, §11 (A17) | A17 said the console returns no display name and no profile id — aggregates only. This crosses that line on purpose: support has to _find_ the account a caller names before it can confirm an address or comp a grant, and paging the whole GoTrue directory in Node to do that is both slow and unfilterable. SECURITY DEFINER to read `auth.users`, granted to `service_role` alone, guarded so CI's bare Postgres returns an empty page. The finding is done in SQL and what it can expose is one reviewable function rather than a habit spread across pages. |
| A33 | **The rate limiter's numbers, made editable.** `rate_limit_settings` (a master switch) and `rate_limit_rules` (per bucket), read by `baaki_rate_limit` on every call and edited from the console. | §11 (A26) | A26 fixed the windows in code. A limit that cannot be changed without a deploy is one that gets turned off _with_ a deploy the night it misfires. A bucket with no row falls back to the code default, so a rule only ever overrides; the master switch exempts everything at once. Granted to `service_role` alone, like everything else the console touches. |
| A34 | **Captures — an expense caught before it has a group.** Record what something cost now (amount, note, category, date, a receipt photo), keep it in a personal inbox, and assign it to a group later — at which point the normal add-expense form opens prefilled and, on save, the capture becomes an ordinary group expense and leaves the inbox. A new `captures` table, owner-only RLS, and four `capture.*` mutation kinds that ride the existing offline queue under a **personal scope**: where a group id normally sits in the envelope and the cursor map, a capture carries the owner's own user id, and `/sync` authorises it by ownership instead of membership. The per-owner `updated_seq` (a counter on `profiles`, stamped by `baaki_next_capture_seq`) is the personal mirror of `baaki_next_group_seq`, so a second device pulls its captures with the same "everything since cursor N". A private `captures` storage bucket holds the photo, owner-only on all four operations. | §2, §4, §9 | §9's only way to record an expense is inside a group, and §2's `expenses`/`receipts` are group-scoped to the bone (`group_id NOT NULL`, membership RLS, a per-group cursor) — a group-less expense there would be wrong in every balance, export and simplification that reads it. So a capture is deliberately **not** an `expenses` row: it carries no members and no split, and becomes one only on assignment. The personal scope is the first sync domain that is a person rather than a group; it generalises to any future per-user data. The word _inbox_ was already the notifications ledger (§7.1) and _draft_ already the crash-recovery form autosave (ADR-005), so this is "captures" in code and "Unassigned"/"Inbox" on screen. `packages/db/test/captures.test.ts` pins the owner boundary, the per-owner sequence and the two CHECKs; `packages/core/test/overlay.test.ts` pins the offline overlay. Built through PRs; like the rest of M4-era work it ships to prod only once the migration and the `sync` function are deployed. |

| A35 | **Archived groups, and the way back.** Archiving a group has always stamped `archived_at` and dropped it off the dashboard, but nothing ever read those rows back — the door was one-way, and a group put away was gone unless you edited the database. A settings screen now lists the archived groups newest-archived first and unarchives each with one tap; unarchiving is an ordinary `group.update` clearing `archived_at`, so the row leaves the archive and returns to the dashboard through the same mirror overlay with no round trip (ADR-005). `materialiseArchivedGroups` is the sibling of `materialiseGroups` — one shared builder, the opposite `archived_at` filter — and the screen is reached from the dashboard's overflow menu. | §9 | §9's screen list has Settings but never an archive view, and `archived_at` (§2) shipped from M0 as a write with no reader. No schema change and no new mutation: the column, its RLS and the `group.update` kind all already existed — only the read and the screen were missing, which is exactly how a one-way archive stays one-way. |

| A36 | **The Friends list is sortable.** A three-dot beside "from contacts" opens a corner dropdown with three keys — amount, recent activity, name — each with an icon; the chosen key shows a direction arrow and tapping it again reverses the sort. To sort by activity, `baaki_people_i_owe` now returns `last_activity_at` — the newest expense version or settlement touching that person. | §8, §9 (A11) | A11 built the Friends view and left it in balance order. The sort is client-side for amount and name, which the RPC already returned; date needed a timestamp it did not, so the function gained one column (a `CREATE OR REPLACE`, `SECURITY INVOKER` unchanged, so it exposes no time from a group the caller cannot already see — and no Prisma datamodel change, since a function is not an object Prisma owns, A7). |

| A37 | **The flat-list reskin, corrected where it dropped meaning.** The WhatsApp-style flattening (bold colour cards → bare rows and hairlines) went one shade too far and stripped signals a bill-splitter cannot lose. Money direction is restored: a balance amount on the Friends list, the group Balances tab and the group card is coloured by its sign again (owed green, owe red — the global money-colour rule in `tokens.ts`), so owed-vs-owing is legible at a glance without relying on a section header that scrolls away; the group card's "you owe / you're owed" word is coloured to match, and a pending settlement is a labelled `Badge` rather than a 7px dot that read as an unread mark. Every network-backed list (Friends, Activity, Inbox, Devices) now branches on the query's error state and shows a retry — a failed fetch no longer reads as "all square" / "nothing yet". Consistency: the group Activity tab is flat like its siblings (was still a boxed `Card`); the month drill-down wears the group's own tint (was hardcoded lilac); an itemize avatar you have not claimed stays legible (opacity floor 0.2 → 0.5); a disputed expense is a `Badge` with a screen-reader label (was a bare 🚩). A destructive capture delete now confirms first. An incomplete-i18n sweep is closed — settle, simplify, the invite landing, and add-from-contacts had shipped English strings in a four-language app; all now route through `t.*` with `fill`/`plural`. And app-wide, footnote sentences moved off `tone="faint"` (11px at ≈3:1, below WCAG AA) to `tone="muted"` (≈7:1). RTL: the activity timeline pads with `paddingStart`, captures' back arrow is `directionalIcon`. | §9, §11, A11, A34 | A senior-designer screen-by-screen audit after the reskin. The reskin was a deliberate, approved direction; this keeps its look while putting back the three things flatness removed by accident — money colour, error states, and the pending badge — plus the polish the flattening left half-applied. No schema, RPC or mutation change: every fix is presentation, i18n copy, or an existing-mutation confirm dialog. |

| A38 | **Merging the same guest across groups — for one viewer, and never in the ledger.** Somebody who added "Rahul" as a ghost in four groups sees four Rahuls on Friends; a `git-merge` action folds them into one name. The merge is a `ghost_merges` row per `(owner, member)` and a coalesce in `baaki_people_i_owe`, where `person_key` becomes `COALESCE(profile_id, merged person_id, member_id)` for that one owner. `baaki_merge_ghosts` (SECURITY DEFINER, all-or-nothing) refuses anything but two or more distinct ghosts the caller shares a group with. Overlapping merges **union rather than overwrite**: every member already sharing a `person_id` with any selected one is pulled in and the whole set is assigned a single canonical `person_id` — an existing one is reused (lowest by order, since `uuid` has no `min()`), so a repeated merge is idempotent — the same set merged again keeps each row's `created_at` and stamps no new sync `updated_seq` (the conflict clause only writes on a real change) — and a transitive merge (`{A,B}` then `{B,C}`) collapses to one Friends total that `baaki_people_i_owe` reads off its normalized `person_id`. Concurrent overlapping merges by one owner are **serialised by a transaction advisory lock** (`pg_advisory_xact_lock` keyed on the owner), so the read-then-write cannot interleave and a race cannot split `{A,B}` and `{B,C}` onto separate identities. Self-references and cycles are **not representable** and so need no rejection: `member_id` (a `group_member`) and the server-minted `person_id` are different namespaces with no member→member edge to close. Every check — membership, ghost-only, the union grouping — is server-side; the client filters nothing. Presented as permanent — a hard "this cannot be undone" warning and no un-merge screen. Mobile: pure `data/mergePeople.ts` (16 tests), `friends/merge.tsx`, a header entry shown only at two-or-more mergeable guests. | §9, A11 | A11 wrote the rule this bends — "ghosts are never merged across groups by name: a name is not proof that two records are one human." That rule guards the **ledger**, and it still holds without exception: no expense, share or balance is rewritten, each group keeps its own ghost and its own per-group balance (ADR-004), and a real person's claim (A25) is untouched. What folds is only the **viewer's own reading** of who is one human — an aggregation in front of the ledger, private to the owner by RLS, asserted to nobody else. A `group_member` is per-group by construction, so "one member, debts summed" is impossible; identity aggregation is the only shape that does not corrupt a balance. The permanence is a product choice, not a database one — the row could be deleted, but a bill-splitter who fuses two people should mean it, so no client offers the reverse. |
| A39 | **A group photo is a paid feature; the cover icon is free.** A group may carry a photograph if anyone in it is on a paid plan or the group holds a pass; a cover emoji is free for everyone, always. A new group gates on its creator. Server-side: `baaki_can_upload_group_photo` (SECURITY DEFINER, members-only, a bare boolean) over `baaki_profile_is_paid`. Mobile shows a "Plus feature" hint and routes a locked photo tap to the upgrade screen; removing an existing photo is never gated. Pure `lib/groupPhotoGate.ts` (12 tests); wired in `new-group.tsx` and `group/[id]/settings.tsx`. | §9, ADR-011 | §9 let anyone set a group photo and ADR-011 named the sellable list without it. It belongs on that list — ADR-011 sells convenience and cosmetics (themes are already there), never the ledger, and a photo is exactly that. It has to be server-side because one member cannot read another's subscription under RLS (ADR-013), so "is anyone here paid" is a question only a definer function can answer without leaking the plan. Functions-only, no table, so `db:drift` sees nothing to reconcile. Note no store sells a subscription yet (`upgrade.tsx` is a screen with no till), so every group is icon-only until one does — which is the gate working, not failing. |
| A40 | **Bring your own key, and who may run the model features.** A settings screen (`settings/ai-keys.tsx`, an "AI" section on the profile screen) takes a model API key for OpenAI (GPT), Anthropic (Claude) or Moonshot (Kimi). **Only one key is connected at a time** — a reader picks the single account the model features run on, so saving a key clears every other provider's (`setActiveAiKey`), and the screen is one card with a provider picker (`ChipRow`) rather than one card per provider; switching the picker to a provider that is not the connected one shows a plain "saving replaces your {provider} key" note. The key is held **on the device only, in the OS keystore** (`lib/aiKeys.ts` over expo-secure-store, the same store as the session refresh token, A-security-2026-08-14), never sent to a Baaki server; it is masked on display, validated on demand by a cheap authenticated GET straight to the provider (`validateAiKey`, a 401/403 is "rejected", anything else is "unreachable"), and removed on request. The connected key also carries four non-secret settings (`lib/aiSettings.ts`, in ordinary AsyncStorage, not the keystore): an on/off switch (pause without deleting), the chosen model (`AI_PROVIDERS[].models`, per provider, default first), a token ceiling, and a running tokens-used counter the features increment (`addAiTokensUsed`). The model-powered features (receipt OCR, voice-to-expense — A5/A6/A1 today are the on-device/dictation versions) obey one access rule, encoded pure in `lib/aiAccessRule.ts` (8 tests) and fed live by `useAiAccess`: **paid → Baaki's managed key; else a brought key that is on and under its ceiling → that key; a key switched off → paused; a key over its ceiling → overlimit; no key → locked (all three non-paid off-states shown greyed, each with its own message and fix).** The settings belong to whichever key is connected, so removing or replacing the key resets them to defaults (`resetAiSettings`) — a new key on a different account never inherits the old one's usage, budget or paused switch — and the connected-key badge reads "Paused" not "In use" while the switch is off. Key and settings mutations announce through one shared signal (`lib/aiEvents.ts`) that every `useAiAccess` consumer subscribes to, so the verdict moves without a remount. The paid signal is `canUploadGroupPhoto(null)` — "am I paid", over `baaki_profile_is_paid` (A39) — until a dedicated entitlement read exists. Strings in all four locales. | §6 (ADR-008), §9, ADR-011, ADR-013 | §6/ADR-008 route every scan through Baaki's own pipeline and key; ADR-011 sells convenience without naming a second way to pay for the model work. BYOK adds one: a reader may spend their own provider account instead of a Baaki plan, and either unlocks the same features. It is client-only and needs no migration — the key never reaches the server, and the paid check reuses an existing definer function — so `db:drift` sees nothing. The keystore, not app storage, because a provider key is a bearer credential to someone's paid account, exactly the threat model the refresh-token hardening addressed. No feature _spends_ a key yet; this is the vault and the access rule the OCR/voice work is built on next. |
| A41 | **Speak an expense (voice quick-add).** A raised mic in the middle of the root bottom bar (`PillTabBar` `centerAction`, `AppTabBar`) opens a modal (`app/voice.tsx`) that captures one spoken sentence on-device (`components/VoiceCapture.tsx` over `expo-speech-recognition`, the same recogniser the note dictation uses — reached through `VoiceMicPanel` behind a lazy require so an older binary degrades instead of crashing at launch, the A-native-module rule). A pure, tested parser (`lib/voiceExpense.ts`, 8 tests) pulls the amount, a currency word, and the group the sentence names by name-token overlap — refusing to guess when two groups tie — and hands off to the ordinary add-expense form prefilled (`?voice=1&amount=&description=`, seeded on the same path as an inbox capture), so the last step is always a glance and a Save, never a blind write. When no group is named, the modal asks which; when no amount is heard, it says so and lets the reader try again. **Heuristic tier only in this increment** — amount + group + note, equal split, no key needed, works for everyone; the "model if a key is present" tier (people and split phrasing via BYOK, counting tokens through `addAiTokensUsed`) is the next increment. Strings in all four locales. | §9, A40, A1/A6 | The dashboard had no one-tap capture for the common case — "I just spent X on the trip"; the mic is that. Transcription is the device's own, so the sentence is not shipped to a server (the same stance as the note dictation, A1's spirit). It reuses the capture-handoff seed path rather than a second prefill mechanism, and creates nothing until the reader saves, so a misheard amount is caught on the form, not in the ledger. Client-only, no migration. The live-speech leg is not verifiable on an emulator (no real mic), like the dictation feature. |

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
| A42 | **User-defined expense tags (custom categories).** The fixed ten (A9) become the starting set of a per-user catalog. A person can create their own tags (a name, an Ionicons glyph, one of the six design-system tints), edit and delete them, and hide or reorder the built-ins — all from **Settings › Tags & categories** (`app/settings/categories.tsx`), with a "＋ New tag" shortcut in the add-expense/capture picker (`TagEditorSheet`). The catalog is a new **personal-scope** synced table `category_tags` — cloned from `captures` (A34): `owner_user_id`, a per-owner `updated_seq` counter + stamp trigger, owner-only RLS, soft delete, and its own suffixed sync cursor (`categoryTagsScope`) so it shares a cursor with neither captures nor ghost merges. One row is either a custom tag (label/icon/tint) or an override of a built-in (`builtin_id` + `sort_order`/`hidden`; a unique partial index keeps that override single). Reads/writes go through `/sync` **as the caller** (owner-only RLS is the whole gate), never a service-role RPC — the personal-write pattern captures established. Because a custom tag is a per-user thing but an expense it tags is shared, the tag's display is **denormalised** onto the ledger: a nullable `category_meta` JSONB (`{label, icon, tint}`) on `expense_versions` and `captures`, written through a new arg on `baaki_apply_expense` (still service-role only, SEC-1) and sanitised at the edge before it lands, so any group member renders the tag without the author's catalog. Past expenses keep their snapshot when a tag is later edited or deleted. The value stored in `category` stays the grouping key (a built-in id or the tag's uuid); `resolveCategory(key, meta)` and `buildCatalog(rows, labelFn)` in `@waves/core` merge and render it, so pickers, badges and the insights charts agree. Reorder is arrow-based in v1 (no new native dependency); drag can follow. | §8 (A9), §11, A34, ADR-013 | A9 fixed the set at ten "because a chart with fifty slices tells nobody anything" — true for a shared default, but a person's own spending is theirs to name, and a fixed English-plus-translation list cannot hold "Client dinner" or "Rent". This keeps the ten as the default and the guess target (custom tags are never auto-guessed), and adds a personal layer on top. It touches no balance — a tag is a label beside `payment_method` and `receipt_share_url`, never part of the split — so ADR-013's money-in-Postgres invariant is untouched. The catalog syncs per-user like captures rather than living only on-device, so a person's tags follow them across devices; it is denormalised onto the ledger rather than joined, because a join across a per-user table would leak one member's catalog to another and still fail offline. |
| A44 | **Image storage moves to Cloudflare R2, with a free-tier storage ceiling.** The four private image buckets (`receipts`, `group-photos`, `avatars`, `captures`) move from Supabase Storage to a single Cloudflare R2 bucket, namespaced by the old bucket name (`<logical>/<path>`). The phone holds **no R2 credential** — a leaked S3 key is the whole bucket — so every read, write and delete **from the client** is brokered by one edge function, `r2-sign` (server-side code such as the receipt-OCR read and the sweep job holds the S3 credentials directly, as it must): it mints a **presigned PUT** (client uploads straight to R2), records the object on `commit`, mints a **presigned GET** for reads, and deletes. A client-side seam (`apps/mobile/src/lib/storage/`) is the only image door; behind a flag (`EXPO_PUBLIC_R2_ENABLED`) it either brokers R2 or falls back to the old direct Supabase call, so the change ships dark and turns on when the secrets exist. **Migration is new-uploads-only**: reads dual-resolve — `r2-sign`'s `get` and the server read helper (`_shared/r2.ts`) return R2 for objects the new `storage_objects` ledger knows and a Supabase signed URL/download for anything older. Images are **WebP** where the device can encode it (`image.ts` tries `SaveFormat.WEBP`, falls back to JPEG on iOS builds without an encoder), with an optional Cloudflare Worker (`infra/r2-image-worker/`) that transcodes the JPEG-fallback minority in place. The **cap** is a per-user aggregate — a free account may store **10 MB** of image bytes (`app_config.free_storage_cap_bytes`, an admin knob like the receipt cap A16); an upload's bytes count against the **uploader's** ceiling unless the uploader is paid **or** the target group's owner is paid, in which case that group's **group-scoped images** (receipts and cover photo) are uncapped for everyone in it, while personal avatars and captures always count against their uploader. Enforced server-side: the presign **reserves** the bytes (`baaki_storage_reserve` writes a `pending` ledger row that counts immediately, so an upload that is never committed cannot fill R2 for free) and `commit` re-checks against the object's true size (`baaki_storage_record`); both raise `STORAGE_CAP`, are serialised per owner by an advisory lock so two uploads cannot both slip under the ceiling, and never trust the client. Over-cap uploads are deleted from R2 and answered 402, which the app turns into an upgrade prompt. Every deleted, expired, or cascade-orphaned object is queued in `storage_orphans` and reclaimed from R2 by a `storage-sweep` job; abandoned reservations are expired by a 15-minute DB cron so the cap frees itself without any R2 credential. | ADR-011, ADR-013, §6 (ADR-008), A16, A34, A39 | ADR-011 sells convenience, not the ledger: storage is convenience, so a free ceiling on image bytes fits it exactly as the receipt cap did. R2 removes Supabase Storage's egress/scaling as the images grow, and its S3 API is the presigned-URL pattern the mobile client already needs — the key never leaves the server. New-uploads-only with a dual-read resolver avoids a bulk copy while keeping every old image serving. WebP is bytes saved in storage, on the wire and in every fetch, for the same visible quality. The cap is measured on the server because a client that could edit its own byte tally could lift its own limit (ADR-013); the paid-group exemption reuses `baaki_group_is_paid` (A16). No money table is touched. |
| A48 | **On-device data encrypted at rest.** The offline SQLite mirror (ADR-005) was a plaintext file in the app sandbox holding the whole ledger — groups, expenses, splits, balances, the mutation queue, autosaved drafts — readable on a rooted device or from a file-level backup (session token and BYOK keys were already in the keystore, A40 / A-security-2026-08-14; the ledger was the gap). Every value the mirror stores in a `json` column is now sealed with **XChaCha20-Poly1305 AEAD** (`@noble/ciphers`, pure JS — no native SQLCipher swap, which would break autolinking on the Expo SDK pin, the A-native-module rule) before it is written and opened after it is read (`apps/mobile/src/sync/rowCipher.ts`). A 256-bit data-encryption key is generated by `expo-crypto` and held in the **OS keystore** (`expo-secure-store`, `AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY` so a backup restore cannot carry it to another device), cached once per process. Each payload is bound to its row identity with **associated data** (`<table>\x1f<id>\x1f<group>\x1f<seq>`), so a ciphertext copied to another row fails to open. A one-time `PRAGMA user_version` migration seals pre-existing plaintext (untagged values pass through on read, are re-sealed on next write); `PRAGMA secure_delete = ON` zeroes freed pages. **Sign-out is a crypto-erase**: `reset()` wipes the tables then `destroyKey()` deletes the DEK, so any ciphertext left in WAL/free pages is unrecoverable and the next account mints a fresh key; sign-out also clears the pending-receipt upload queue and the cached-image directory (`clearReceiptQueue` / `clearImageCache`). Separately, the offline write queue now carries `baseVersionNo` / `receiptId` / `receiptShareUrl` so an offline **edit** reaches `/sync` with the base version the §4.4 conflict check needs, matching the direct `expense-write` path (`data/serialiseExpense.ts`). **Web is left plaintext on purpose** — a browser has no keystore, so any key would sit beside the data; a future full web client would move to IndexedDB + a non-extractable WebCrypto key. Native only; ships on the next OTA/native build. | ADR-005, A40, ADR-013 | ADR-005 chose a local mirror for offline use but said nothing about protecting it at rest; full-disk encryption and the sandbox stop other apps and a powered-off device, not a rooted filesystem or a backup extraction, and the mirror holds the entire ledger. The secrets vault (A40, refresh token) already used the keystore; extending the same posture to the ledger closes the one plaintext store. Application-layer (the `json` column, never filtered or sorted on — read and written whole) rather than SQLCipher, so sealing that one column covers the payload with zero native-module change. Trust boundary: this defends data **at rest** (off-device extraction, rooted fs, backup theft); it does not defend a running, unlocked, compromised device — the key is available to the app at runtime, the same posture as the token/AI-key vaults. A lock-gated key is a possible follow-up. |
| A49 | **Delete a group (Splitwise-style), as a settled-gated group-wide tombstone.** A group admin can delete a whole group for everyone; it disappears from every member's app on their next sync. Within ADR-004's append-only rule this is **not** a hard delete: a new `groups.deleted_at` column is set, exactly mirroring `archived_at`, **except** a deleted group is excluded from **both** the active list and the Archive (`materialiseGroups` / `materialiseArchivedGroups` / `useLocalGroups` / `useGroup` all filter `!deleted_at`; `fetchGroups` and the `GROUP_SELECT` narrow read add `.is('deleted_at', null)`), so it is shown nowhere — no ledger row is erased and history stays reconstructible. Both guards are enforced **server-side** in `baaki_delete_group` (a `SECURITY DEFINER` RPC, so a raw client PATCH cannot bypass them, ADR-013): the caller must be a group **admin** (`is_group_admin`, reusing the ADR-006 role addendum — Splitwise lets any member delete, but Baaki already distinguishes admins and deleting-for-everyone is an admin power) and the **whole group must be settled** — `baaki_group_balances_truth` (the same source `baaki_refresh_group_balances` derives from) must return no non-zero row, i.e. every member square in **every** currency, else `NOT_SETTLED`; a non-admin gets `NOT_ADMIN`. The RPC is idempotent (a second call on an already-deleted group is a clean no-op), and the existing `groups_stamp_seq` trigger bumps `updated_seq` so the tombstone rides the ordinary sync pull (`select('*')`) to every member's mirror. The client button (`group/[id]/settings.tsx`, a `ghostDanger` `Delete group` beside Archive/Leave) is shown only to an admin and, on press, blocks with the group-wide `settleAllFirstBody` unless `useGroupLedger().groupSettled` (every member, every currency) is true, then confirms destructively before calling `useDeleteGroup` → `router.replace('/')`. New i18n keys `deleteGroup`/`deleteQuestion`/`deleteBody`/`delete`/`settleAllFirstBody`/`deleteAdminOnly` in all four locales. Migration `20260827000000_group_delete` (column + RPC) is **undeployed** — it ships in the PR and is applied later. | ADR-004, ADR-006 (roles), ADR-013, ADR-005 | ADR-004 forbids destructive deletes precisely because a competitor lets one member erase an expense for everyone; a group delete that honoured that had to be a tombstone, not a `DELETE`. Archive already had the exact shape (`archived_at` + a mirror filter), so delete reuses it wholesale and differs in only one bit: an archive is recoverable and listed, a delete is shown nowhere. The two guards live in one definer RPC rather than a client column write because a settled/admin check the client owns is a check an attacker owns (ADR-013); the settled check reads the balances-truth source so it can never disagree with the stored `group_balances`. Admin-gated rather than any-member because Baaki, unlike Splitwise, already has admins and this action hits everyone. No money table or balance formula is touched. |
