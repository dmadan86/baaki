# Baaki — Architecture Decision Records (ADR)

**Product:** Baaki (பாக்கி — "balance / what's still owed") — expense-splitting app.
**Positioning (from competitive analysis):** unlimited free core ledger · link-based guest joining · UPI-native settlement with partial/per-expense payments · free AI receipt itemization · monetize convenience, never the ledger.
**Status legend:** Accepted = build to this. Each ADR: Context → Decision → Consequences.

---

## ADR-001: Cross-platform mobile with React Native + Expo

**Status:** Accepted

**Context.** India-first (Android-heavy) but iOS must not lag; small team; fast iteration; need push notifications, camera (receipts), deep links (UPI intents), and OTA updates.

**Decision.** React Native with **Expo (managed workflow, latest SDK)**, TypeScript strict mode. Expo Router for navigation. EAS Build for store binaries, EAS Update for OTA JS updates. Eject only if a native module forces it.

**Consequences.** One codebase for Android + iOS; UPI intent links work via `Linking` on Android (primary market) and fall back gracefully on iOS. SMS-reading auto-import (Android-only, Splitkaro-style) is deferred because Expo managed workflow restricts SMS permissions — revisit in a later phase (ADR may be superseded then). Web can come later via Expo Web or separate Next.js against the same backend.

---

## ADR-002: Supabase as the backend platform

**Status:** Accepted

**Context.** Need Postgres-grade relational integrity for a money ledger, auth (including anonymous/guest), realtime group sync, file storage for receipts, and serverless functions — without building/operating servers.

**Decision.** **Supabase**: Postgres (source of truth), Supabase Auth (anonymous + phone OTP + Google/Apple), Realtime (Postgres changes → group subscriptions), Storage (receipt images), **Edge Functions** (Deno/TypeScript) for anything that must not run client-side (AI receipt parsing, invite-token minting, notification fanout, exports). All schema changes via versioned SQL migrations in the repo (`supabase/migrations`), runnable locally with the Supabase CLI.

**Consequences.** Massive velocity win; RLS gives per-row security (ADR-013). Vendor risk is acceptable: it's plain Postgres underneath, exportable via `pg_dump`. Business logic that affects balances lives in **Postgres functions/constraints and Edge Functions, never only in the client**.

---

## ADR-003: Money stored as integer minor units, never floats

**Status:** Accepted

**Context.** Floating-point math produces the penny-rounding bugs users mock in competitors (₹0.01 ghost balances).

**Decision.** All amounts are `BIGINT` **minor units** (paise, cents) plus an ISO-4217 `currency_code` (`CHAR(3)`) and a `minor_unit_exponent` lookup. Client formats for display only. FX conversions store `(rate_numerator, rate_denominator, rate_timestamp, source)` so every conversion is reproducible. No `FLOAT`/`NUMERIC` arithmetic on amounts anywhere in app code; division happens only inside the split algorithm (ADR-009) which distributes remainders deterministically.

**Consequences.** Exact math everywhere; slightly more formatting code; multi-currency groups keep per-currency balances plus an optional converted "display total".

---

## ADR-004: Append-only ledger with derived balances (event-sourced-lite)

**Status:** Accepted

**Context.** Competitors suffer destructive deletes (one member erases an expense for everyone), sync corruption, and un-auditable balances. Trust in the number IS the product.

**Decision.**

- `expenses` and `settlements` rows are **never hard-deleted or updated in place**. Edits create a new `expense_versions` row; deletes set `deleted_at` (soft) — restorable by any group member for 30 days; every change lands in an `activity_log` visible to the group.
- **Balances are always derived** by aggregating expense_shares and settlements — never stored as a mutable running total. A materialized `group_balances` view (refreshed transactionally via triggers) provides fast reads; the ground-truth query must reproduce it exactly (invariant-tested in CI: sum of all balances in a group ≡ 0 per currency).

**Consequences.** Full audit trail ("who changed this split and when"), safe undo, and sync conflicts can't corrupt totals — worst case a duplicate version, never a wrong balance. Storage grows with history; acceptable at this data size.

---

## ADR-005: Offline-first client with queued mutations

**Status:** Accepted

**Context.** Trips = airplanes, hill stations, dead zones. Splitwise gated offline behind Pro; Splid wins on this. Also fixes the "crash loses my draft" complaint.

**Decision.** Local **SQLite** (expo-sqlite) mirror of the user's groups; UI reads local-first, always. Writes append to a local **mutation queue** (each mutation carries a client-generated UUID as **idempotency key** + `client_created_at`). A sync engine replays the queue against Supabase when online; server upserts by idempotency key (safe retries). Conflict policy: append-only model (ADR-004) makes true conflicts rare — concurrent edits to the same expense resolve **last-write-wins by server receipt time**, with the losing version preserved in `expense_versions` and surfaced in the activity feed. Drafts autosave to SQLite on every keystroke.

**Consequences.** App is fully usable offline (add/edit/view); no lost entries on crash; sync code is the hardest part of the client — it gets the deepest test suite (ADR-014).

---

## ADR-006: Guest access via invite links + claimable ghost members

**Status:** Accepted

**Context.** #2 category complaint: forcing every participant to install + register. Tricount/Kittysplit prove link-joining grows adoption.

**Decision.**

- Any member can create a **group invite link** (signed, revocable, expiring token minted by an Edge Function).
- Opening the link in a browser shows a **read-write web-lite group view** (Supabase **anonymous auth** session) — view balances, add expenses — no install, no account. The page upsells the app but never blocks.
- Members can add **ghost participants** by name only ("Rahul"). A ghost holds shares/balances like anyone. When a real person joins via link, they can **claim** a ghost (organizer confirms) and inherit its history atomically.
- Anonymous sessions upgrade in place to phone-OTP/Google/Apple accounts without losing data (Supabase `linkIdentity`).

**Consequences.** Zero-friction adoption loop; ghost-claiming needs careful merge logic (single Edge Function transaction); anonymous write access is scoped strictly to the invited group by RLS (ADR-013).

---

## ADR-007: UPI settlement via intent deep links; Baaki never moves money

**Status:** Accepted

**Context.** Top structural gap in the market: India has no Splitwise-class app with real UPI settlement. Holding/moving money requires PSP licensing; deep links don't.

**Decision.**

- Settlement launches a standard **UPI intent URI** (`upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>`), opening the payer's chooser (GPay/PhonePe/Paytm/any UPI app). Users store an optional VPA (UPI ID) on their profile; per-group override allowed.
- Baaki records the settlement with a two-step state machine: `initiated → confirmed` (payee taps "received" or payer marks paid and payee gets a confirm nudge; auto-confirm after 7 days with notification). We do **not** attempt callback verification of UPI success in v1 (intent flow offers none reliably).
- **Partial and per-expense settlement is first-class** (the 985-vote gap): a settlement row can carry `allocations[] = {expense_id, amount}`; unallocated amounts apply to overall balance oldest-first. Cash/bank settlements use the same flow minus the deep link.

**Consequences.** No license, no float, no custody risk; works with every UPI app on day one. Trade-off: confirmation is social, not cryptographic — mitigated by the confirm/nudge flow and activity log. International rails later (Venmo/PayPal links, SEPA) plug into the same settlement state machine.

---

## ADR-008: AI receipt itemization server-side via vision LLM

**Status:** Accepted

**Context.** 2026 table stakes; must handle Indian receipts (Tamil/Hindi/regional scripts), photos from gallery, and pasted text bills (Swiggy/Zomato/WhatsApp) — all things Splitwise fails at. API keys must never ship in the client.

**Decision.**

- Client uploads image (or pastes text) → Supabase Storage → **Edge Function** calls a **vision-capable LLM (Claude API)** with a strict JSON schema: `{merchant, date, currency, items[{label, qty, unit_price, total}], subtotal, taxes[], service_charge, tip, discounts[], grand_total}`; validate that items+taxes reconcile to the printed total, else flag low-confidence lines for user correction (editable review screen — AI proposes, human confirms).
- Itemized claiming: each participant taps their items on their own phone (Tab-style, realtime via Supabase Realtime); shared items split equally among claimers; **tax/tip/service prorated proportionally** to each person's item subtotal (deterministic rounding per ADR-009).
- Free tier: generous scan quota (e.g., 20/month); metered because each scan has real API cost — consistent with ADR-011 (convenience is monetizable, ledger is not).

**Consequences.** Best-in-class scan UX incl. regional scripts and text bills; per-scan cost is a COGS line to monitor; provider is swappable behind one Edge Function interface.

---

## ADR-009: Deterministic split & debt-simplification algorithms

**Status:** Accepted

**Context.** Split math must be exact, reproducible on every device, and never leak paise.

**Decision.**

- **Split types:** equal, exact amounts, percentages, shares/weights, +/- adjustments, itemized (ADR-008). Multiple payers per expense supported.
- **Remainder rule:** integer division distributes the remainder one minor unit at a time in a **deterministic order** (participants sorted by stable member ID, offset rotated by `expense_id` hash so the same person doesn't always eat the extra paisa). Property test: shares always sum exactly to the total.
- **Simplify debts:** per-currency **min-cash-flow** (greedy max-debtor→max-creditor matching), as a _suggestion layer only_ — underlying pairwise ledger is preserved, so toggling simplification never rewrites history. Per-group setting, on by default for trip groups.

**Consequences.** Identical results client-side (offline preview) and server-side (truth); simplification stays explainable ("why am I paying Priya?" → expandable derivation).

---

## ADR-010: Notifications — push-first, digest email, "only what involves me"

**Status:** Accepted

**Context.** Splitwise is simultaneously spammy (emails for everything) and silent (weak push) — a top-5 complaint.

**Decision.** Expo Push Notifications as the primary channel; email (Resend, via Edge Function) only for weekly digest + settlement confirmations + account events. Defaults: push only for events **involving me** (I owe / I'm owed / I'm mentioned / settlement confirm), daily-batched group activity summary, all granularly configurable per group. Reminder nudges (ADR-007) are user-initiated ("nudge politely") plus optional scheduled auto-reminders with due dates — always visible to both parties, tone-tested to stay friendly (vasool-but-nice).

**Consequences.** Requires a notification-preferences model and a fanout Edge Function with batching; avoids the churn-driving spam problem.

---

## ADR-011: Monetization guardrails (product-level ADR)

**Status:** Accepted

**Context.** Splitwise's daily cap on the core loop is the category's biggest churn engine. Baaki's positioning depends on never repeating it.

**Decision.** Constitutional rules enforced in code review: **(1)** manual expense entry, groups, split types, balances, settlement recording, and export are unlimited and free, forever — no daily caps, no interstitial ads, ever. **(2)** Monetize convenience: AI scan volume beyond free quota, analytics/charts depth, auto-import (future), group/trip passes (Settle Up-style shareable premium), themes. **(3)** India pricing in INR at local purchasing power (~₹49–99/mo tier), regional pricing elsewhere. **(4)** No third-party ads in any money flow.

**Consequences.** Slower revenue early; durable trust moat and the marketing wedge ("the ledger is free forever") that the entire alternatives market currently wins with.

---

## ADR-012: Data portability — full-fidelity export and competitor import

**Status:** Accepted

**Context.** Splitwise's lossy CSV + lock-in fear directly created its FOSS competitor wave.

**Decision.** Per-group and per-account export as **JSON (lossless: versions, settlements, allocations, receipt URLs)** and **CSV (locale-aware separators, includes per-person settlement detail)**, generated by an Edge Function, free tier included. **Splitwise CSV import** ships in v1 (map members → ghosts, claimable later) as the switching on-ramp. Public read API deferred but schema designed for it.

**Consequences.** Trust + switching growth loop; import mapping UI is real work but directly monetizes competitor churn.

---

## ADR-013: Security via Postgres Row-Level Security + Edge Function privileges

**Status:** Accepted

**Context.** Anonymous guests, ghost claiming, and money data demand precise authorization; client code must be assumed hostile.

**Decision.** RLS on every table: membership-scoped access (`is_group_member(group_id)` security-definer function); guests' anonymous JWTs carry group scope claims; mutations that cross privilege boundaries (ghost claim/merge, invite minting, quota-metered AI calls, notification fanout, exports) run **only** in Edge Functions with the service role after explicit authorization checks. Receipt images in private Storage buckets behind signed URLs. PII minimized: phone OR OAuth identity, display name, optional VPA; no contacts upload in v1. App-level biometric/PIN lock. Rate limits on invite creation and scans.

**Consequences.** Security lives in one reviewable place (SQL policies + few functions); every new table ships with policies + policy tests or fails CI.

---

## ADR-014: Testing & quality strategy

**Status:** Accepted

**Context.** A money app with offline sync has two catastrophic failure modes: wrong balances and lost data. Both are testable.

**Decision.** **(1) Property-based tests** (fast-check) on all money math: splits sum exactly, balances sum to zero, simplification conserves pairwise net positions, FX reproducibility. **(2) Sync simulation tests:** scripted multi-device scenarios (offline edits, dupes, out-of-order replay, claim-merge races) against a local Supabase instance. **(3) RLS policy tests** per table (allowed/denied matrices). **(4) E2E happy paths** (Maestro) for: create group → invite guest → add expense → scan receipt → claim items → UPI settle → confirm. CI (GitHub Actions) blocks merge on all four suites; migrations tested up+down.

**Consequences.** Slower first sprint, drastically cheaper every sprint after; the invariants ARE the product promise ("your baaki is always right").

---

## Decision summary table

| #   | Decision                           | One-liner                                                     |
| --- | ---------------------------------- | ------------------------------------------------------------- |
| 001 | Expo React Native                  | One codebase, Android-first reality, OTA updates              |
| 002 | Supabase                           | Postgres truth + auth + realtime + edge functions             |
| 003 | Integer minor units                | No float money, ever                                          |
| 004 | Append-only ledger                 | Derived balances, soft delete, full audit                     |
| 005 | Offline-first + mutation queue     | SQLite mirror, idempotent sync                                |
| 006 | Invite links + ghost members       | No forced signup; claimable history                           |
| 007 | UPI intent links                   | Settlement without a license; partial/per-expense first-class |
| 008 | Server-side vision LLM             | Free-quota AI itemization, regional scripts, text bills       |
| 009 | Deterministic split math           | Remainder rotation; min-cash-flow suggestions                 |
| 010 | Push-first notifications           | Only-what-involves-me defaults                                |
| 011 | Monetization guardrails            | Ledger free forever; sell convenience                         |
| 012 | Lossless export + Splitwise import | Portability as growth loop                                    |
| 013 | RLS everywhere                     | Client assumed hostile                                        |
| 014 | Property/sync/RLS/E2E tests        | Balances provably correct                                     |
