# Waves — Architecture Decision Records (ADR)

**Product:** Waves — an expense-splitting app for a **global audience**, launching India-first.
**Positioning (from competitive analysis):** unlimited free core ledger · link-based guest joining · multi-currency from day one · deep-link settlement with partial/per-expense payments (UPI first, PayPal/PayID and more worldwide) · AI receipt itemization free within a monthly scan quota (ADR-008) · monetize convenience, never the ledger.
**Reach.** India is the first market, not the only one: it sets the launch rails (UPI), the receipt scripts and the entry price tier, but the ledger, currency and sync are market-neutral. A new country is a settlement rail plus a price tier (ADR-007, ADR-011 pricing), never a schema change.
**Status legend:** Accepted = build to this. Each ADR: Context → Decision → Consequences.

---

## ADR-001: Cross-platform mobile with React Native + Expo

**Status:** Accepted

**Context.** Global audience, launching India-first (Android-heavy) — every market matters and iOS must not lag; small team; fast iteration; need push notifications, camera (receipts), deep links (settlement intents), and OTA updates.

**Decision.** React Native with **Expo (managed workflow, latest SDK)**, TypeScript strict mode. Expo Router for navigation. EAS Build for store binaries, EAS Update for OTA JS updates. Eject only if a native module forces it — and so far none has: the native modules that did arrive (ML Kit text recognition, the document scanner, maps, and the phone's own widget/watch surfaces) are carried by Continuous Native Generation instead, with repo-local config plugins (`apps/mobile/plugins/`), a local Expo module for the watch transport (`apps/mobile/modules/waves-watch`) and Apple targets for the widgets. No native directory is checked in, so `prebuild` stays disposable and an SDK upgrade is still a dependency bump rather than a merge.

**Consequences.** One codebase for Android + iOS; UPI intent links work via `Linking` on Android (primary market) and fall back gracefully on iOS. SMS-reading auto-import (Android-only, Splitkaro-style) turned out not to be blocked by the workflow at all — a third-party reader behind a config plugin ships fine under CNG, and it did ship (#114) before being withdrawn with the rest of the group-import section (#241) because pasting proved a better trade than holding an inbox-read permission. What survives is deliberately inert: the pure parser in `@waves/core` (`sms/parse.ts`, which proposes and never writes), the localised strings, and a dormant `sms_inbox_read` feature flag — so the decision to re-open it is a product call and a permission prompt, not a platform migration. Web can come later via Expo Web or separate Next.js against the same backend.

---

## ADR-002: Supabase as the backend platform

**Status:** Accepted

**Context.** Need Postgres-grade relational integrity for a money ledger, auth (including anonymous/guest), realtime group sync, file storage for receipts, and serverless functions — without building/operating servers.

**Decision.** **Supabase**: Postgres (source of truth), Supabase Auth (anonymous + email-and-password + passwordless email code + phone OTP + Google/Apple), Realtime (Postgres changes → group subscriptions), Storage (receipt images), **Edge Functions** (Deno/TypeScript) for anything that must not run client-side (AI receipt parsing, invite-token minting, notification fanout, exports). All schema changes via versioned SQL migrations in the repo (`packages/db/prisma/migrations`, applied with Prisma Migrate and checked for drift against `packages/db/prisma/schema.prisma`), runnable locally against a plain Postgres — the migrations are ordinary SQL, so nothing about the schema depends on the Supabase CLI being the thing that applies it.

**Consequences.** Massive velocity win; RLS gives per-row security (ADR-013). Vendor risk is acceptable: it's plain Postgres underneath, exportable via `pg_dump`. That acceptance has since been made testable rather than left as a claim — the migrations are ordinary SQL a plain Postgres will take, `infra/self-host/` stands the whole stack up on Docker and `MIGRATION.md` is the route out, and the mobile client reaches the vendor through a single `Backend` port (`lib/backend`) that an eslint rule keeps everything else out of. Object storage has already moved off the platform: image bytes go to Cloudflare R2 behind a flag, with a dual-read fallback for objects written before the cut-over. What is left genuinely coupled is the auth surface (anonymous sessions and in-place upgrade) and `pg_net`. Business logic that affects balances lives in **Postgres functions/constraints and Edge Functions, never only in the client**.

---

## ADR-003: Money stored as integer minor units, never floats

**Status:** Accepted

**Context.** Floating-point math produces the penny-rounding bugs users mock in competitors (₹0.01 ghost balances).

**Decision.** All amounts are `BIGINT` **minor units** (paise, cents) plus an ISO-4217 `currency_code` (`CHAR(3)`) and a `minor_unit_exponent` lookup. Client formats for display only. FX conversions store the exact rational rate and its provenance — `{num, den, ts, source}` — so every conversion is reproducible: `FxRate` in `@waves/core` is the type, and it is persisted as JSON rather than as columns, per-bill on `expense_versions.fx` and per-trip on `groups.fx_rates` (a map keyed by the currency paid in, written only through `waves_set_group_fx_rate`). No `FLOAT`/`NUMERIC` arithmetic on amounts anywhere in app code; division happens only inside the split algorithm (ADR-009) which distributes remainders deterministically.

**Consequences.** Exact math everywhere; slightly more formatting code; multi-currency groups keep per-currency balances plus an optional converted "display total".

---

## ADR-004: Append-only ledger with derived balances (event-sourced-lite)

**Status:** Accepted

**Context.** Competitors suffer destructive deletes (one member erases an expense for everyone), sync corruption, and un-auditable balances. Trust in the number IS the product.

**Decision.**

- `expenses` and `settlements` rows are **never hard-deleted or updated in place**. Edits create a new `expense_versions` row; deletes set `deleted_at` (soft) — restorable by any group member for 30 days; every change lands in an `activity_log` visible to the group.
- **Balances are always derived** by aggregating expense_shares and settlements — never stored as a mutable running total. A `group_balances` **projection table** (rebuilt for just that group, inside the writing transaction, by a trigger calling `waves_refresh_group_balances`) provides fast reads — a table rather than a materialized view precisely because a matview can only be refreshed whole, and the refresh has to be per-group and transactional; the ground-truth query it derives from, `waves_group_balances_truth`, must reproduce it exactly (invariant-tested in CI: sum of all balances in a group ≡ 0 per currency).

**Consequences.** Full audit trail ("who changed this split and when"), safe undo, and sync conflicts can't corrupt totals — worst case a duplicate version, never a wrong balance. Storage grows with history; acceptable at this data size.

**Addendum (deleting a group is a group-wide tombstone, never a hard delete).** Splitwise lets you delete a whole group; Waves does too, but within this ADR's append-only rule. A delete sets a new `groups.deleted_at`, exactly mirroring how `archived_at` already works, **except** a deleted group is hidden from **both** the active list and the Archive (an archive is recoverable and shown; a delete is not shown anywhere) — no ledger row is ever erased, so balances and history stay reconstructible. Two guards are enforced **server-side** in `waves_delete_group` (a `SECURITY DEFINER` RPC, not a client column write, so a raw PATCH cannot bypass them): the caller must be a group **admin** (`is_group_admin`, reusing the ADR-006 role addendum — Splitwise allows any member, but Waves already has admins and deleting for everyone is an admin power), and the **whole group must be settled** — `waves_group_balances_truth` must return no non-zero row, i.e. every member square in every currency, so nobody's owed balance is dropped out from under them. The RPC is idempotent (a second call on an already-deleted group is a clean no-op), and the `updated_seq` stamp trigger carries the tombstone to every member's mirror on their next sync. The client button is admin-only and settle-gated purely as the courteous front of this boundary. See TDR A49.

---

## ADR-005: Offline-first client with queued mutations

**Status:** Accepted

**Context.** Trips = airplanes, hill stations, dead zones. Splitwise gated offline behind Pro; Splid wins on this. Also fixes the "crash loses my draft" complaint.

**Decision.** Local **SQLite** (expo-sqlite) mirror of everything the user can see — their groups, and, under a **personal scope** keyed by their own user id rather than a group, the things that have no group at all: captures caught before they belong anywhere, the per-user expense-tag catalog, and the private personal ledger. The scope is the same queue and the same cursor machinery with the owner's id in the `groupId` slot, so the server authorises by ownership instead of membership and nothing new had to be invented for a second kind of ownership. UI reads local-first, always. Writes append to a local **mutation queue** (each mutation carries a client-generated UUID as **idempotency key** + `client_created_at`). A sync engine replays the queue against Supabase when online; server upserts by idempotency key (safe retries). Conflict policy: append-only model (ADR-004) makes true conflicts rare — concurrent edits to the same expense resolve **last-write-wins by server receipt time**, with the losing version preserved in `expense_versions` and surfaced in the activity feed. Drafts autosave to SQLite on every keystroke.

**Consequences.** App is fully usable offline (add/edit/view); no lost entries on crash; sync code is the hardest part of the client — it gets the deepest test suite (ADR-014).

**Addendum (what deliberately does not ride the queue).** Every write that moves a balance goes through the queue — that is the rule and it has not bent. A second, smaller class of write calls its `SECURITY DEFINER` RPC directly and is therefore online-only: expense comments, expense attachments and settlement proofs, and the three administrative acts (promote/demote a member, delete a group, fold two guests into one name). Two reasons, both deliberate: none of them changes a number, so replaying one out of order can produce a stale opinion but never a wrong balance; and each is gated on a server-side check — admin, party, or two distinct ghosts — that a queued mutation would have to duplicate on the client to give honest optimistic feedback. Reads for all of them still come from the mirror, so the offline gap is the act, not the view.

**Addendum (at-rest encryption).** The mirror was originally a plaintext SQLite file. Its `json` payload columns are now sealed with an application-layer AEAD keyed from the OS keystore, so a rooted device or a file-level backup no longer exposes the ledger; sign-out is a crypto-erase (see TDR A48). The choice was application-layer over SQLCipher because the sensitive content lives only in `json` columns that are never filtered or sorted on, so no native SQLite swap is needed. This is native only: the web store is a different driver (AsyncStorage, because expo-sqlite's WASM build needs COOP/COEP headers a static export does not send) and its payloads are left plaintext on purpose — a browser has no keystore, so any key that code could reach would sit in the same origin as the data and protect nothing. The browser equivalent, if a long-lived web client ever warrants it, is IndexedDB behind a non-extractable WebCrypto key.

---

## ADR-006: Guest access via invite links + claimable ghost members

**Status:** Accepted

**Context.** #2 category complaint: forcing every participant to install + register. Tricount/Kittysplit prove link-joining grows adoption.

**Decision.**

- Any member can create a **group invite link** (signed, revocable, expiring token minted by an Edge Function).
- Opening the link in a browser shows a **read-write web-lite group view** (Supabase **anonymous auth** session) — view balances, add expenses — no install, no account. The page upsells the app but never blocks.
- Members can add **ghost participants** by name only ("Rahul"). A ghost holds shares/balances like anyone. When a real person joins via link, they can **claim** a ghost (organizer confirms) and inherit its history atomically.
- Anonymous sessions upgrade in place — to an email-and-password account, a passwordless email code, phone OTP, Google or Apple — without losing data. Which Supabase call performs it is never left to the screen: `planAuth` in `@waves/core` decides, and for a guest it is always an _addition_ to the account they already have (`linkIdentity` for a provider, `updateUser` for a credential), because the obvious call — `signInWithOAuth` — mints a new user and quietly hands their trip to an account they can no longer reach.

**Consequences.** Zero-friction adoption loop; ghost-claiming needs careful merge logic (single Edge Function transaction); a guest is scoped by exactly the same RLS as anybody else (ADR-013) — a Supabase anonymous session carries the `authenticated` role with an `is_anonymous` flag, not a separate `anon` role, so every group policy is the ordinary `is_group_member` membership check and there is no guest-shaped hole to get wrong. What the true signed-out `anon` role reaches is three read-only tables — the minimum supported version, whether the country is open, and the feature flags — and nothing else; Supabase's default privileges hand out more than that as objects are created, so a migration takes it back and a test proves it. What bounds a guest is therefore membership plus the ceilings below, not a special policy.

**Addendum (guest ceilings).** The zero-friction door stays open, but a guest is not an indefinite free tier. Two limits apply to an anonymous session, and only to an anonymous session:

- **One group.** A guest may belong to **exactly one** group at a time — whether they created it or accepted an invite (any membership counts, not just creation). Starting or joining a second prompts sign-up first.
- **Ten days.** A guest may write for **ten days** from account creation. After that the session is **read-only**: their groups and history stay fully visible, but any write (add/edit expense, settle, new group, join) prompts sign-up. Reading is never gated.

Both gate _toward_ the in-place upgrade above, never away from data: signing up keeps the same user id, so everything made as a guest comes with them. The limits therefore **gate, never wipe**, and lifting the ceiling is the act of keeping the account, not a purchase — consistent with ADR-011 (the ledger is free forever; only convenience is ever sold).

The rule is defined once as a pure function (`guestGate` in `@waves/core`) and enforced in three places so a client that bypasses the app's own guard cannot slip past: the mobile UI (disables the actions), `waves_create_group` (refuses a second group / expired guest, covering the offline `group.create` path too), and the `sync` + `invite-accept` Edge Functions (refuse expired-guest writes and over-limit joins). A full account has no ceiling.

**Addendum (web is a full client, not "lite").** The original decision scoped the browser to a "read-write web-lite group view" — one invited group, upsell the app. That scope is superseded: `apps/web` (renamed from `apps/web-lite`) is now a **full web client** signing in the same three ways the phone does — Google, an email-and-password account, or a passwordless email link — through the same `planAuth` decision in `@waves/core`, so a guest upgrading in the browser keeps their user id exactly as they would on the phone, and showing every group the session may see — an overview dashboard, group detail, settle, friends, and the rest, in phases (see `apps/web/PLAN.md`). This is a **product-scope expansion, not a change to any trust boundary**:

- Guest ceilings are **unchanged**. The one-group / ten-day limits still apply to an anonymous session on the web exactly as on the phone; the same server enforcers (above) refuse over-limit writes regardless of client, which is what actually holds the line; the web UI does not yet read `guestGate` itself, so a guest in the browser gets a plain "keep your account" banner and meets the ceiling as a refused write rather than as a disabled button. That is a worse prompt, not a weaker boundary — closing it is a web change, not a server one.
- **Authorization is untouched.** Every web read runs under the caller's own session and every RLS policy applies unchanged (ADR-013); every money write still goes through the Edge Functions, which recompute shares server-side (TDR §4). The browser is given no authority it did not already have as a guest link view.
- The invite-link + anonymous-guest entry stays; a real login is added beside it, not in front of it. Signing in keeps the same user id, so a guest's history carries into the full account (the in-place upgrade above).

The folder keeps building as `apps/web`; "lite" is historical.

**Addendum (member roles — an admin can promote another member).** The original decision named an "organizer" who confirms ghost claims but never said how roles are granted, and the security hardening (migration `20260807090000`, §4) pinned roles shut with the note "nothing in the product changes a role at all." That is now superseded for one specific, safe shape: **an existing admin may make another member an admin, or demote one back.**

- The self-promotion attack that hardening closed **stays closed**. The trigger `waves_guard_membership_columns` still raises on any signed-in client that writes `role`. Nothing about that block is loosened.
- The only door is a single `SECURITY DEFINER` RPC, `waves_set_member_role`, gated on `is_group_admin`. It runs as its owner, which is the one caller the trigger already lets through — so authority to change a role lives entirely in "are you already an admin of this group", checked server-side, never in the client (ADR-013).
- Two invariants the RPC enforces that a raw column could not: a **ghost cannot be an admin** (it has no account to act with), and a group **never loses its last admin** (demoting the only one is refused, so a group cannot be orphaned into a state where nobody can promote anybody).
- The mobile UI offers the toggle only to an admin, only on another real member. The button is a convenience; the RPC is the enforcement. A demote that would remove the last admin is offered by no client and refused by the server regardless.

This is an **authority-model addition, not a change to any trust boundary**: every existing RLS policy and Edge Function privilege is unchanged, and the set of things an admin can do (edit the group, manage members, set the overall trip budget) is unchanged — only _who_ can be granted that set is now itself an admin decision instead of fixed at group creation.

**Addendum (folding one guest seen across groups — for the viewer, not the ledger).** This ADR always warned that ghost-claiming "needs careful merge logic," and the ledger's rule (TDR A11) is absolute: ghosts are never merged by name, because a name is not proof two records are one human. That rule stands, and nothing below touches it. What it did not cover is the reading problem it creates: a person who adds "Rahul" as a fresh ghost in four separate groups sees four Rahuls on their Friends list. So a viewer may now **fold those into one name — for their own eyes only.** The fold is a `ghost_merges` row scoped to the owner by RLS, read by `waves_people_i_owe` as a coalesce on `person_key`; each group keeps its own ghost and its own per-group balance (ADR-004), no expense or share is rewritten, and a later real-person claim is unaffected. Because a `group_member` is per-group by construction, "one member with summed debts" is impossible — the fold is identity aggregation in front of the ledger, never a change to it. It is presented as permanent (a hard "cannot be undone" warning, no un-merge screen); the row is recoverable at the database, but no client offers the reverse, because fusing two people is a deliberate act. `waves_merge_ghosts` is SECURITY DEFINER and requires two or more distinct ghosts the caller shares a group with. See TDR A38.

---

## ADR-007: UPI settlement via intent deep links; Waves never moves money

**Status:** Accepted

**Context.** Top structural gap in the launch market: India has no Splitwise-class app with real UPI settlement. Holding/moving money requires PSP licensing; deep links don't. The deep-link-and-confirm pattern is not India-specific — it is the rail for every market (see A27: PayID, PayPal), UPI is simply the one the first market ships on.

**Decision.**

- Settlement launches a standard **UPI intent URI** (`upi://pay?pa=<vpa>&pn=<name>&am=<amount>&cu=INR&tn=<note>`), opening the payer's chooser (GPay/PhonePe/Paytm/any UPI app). Users store an optional VPA (UPI ID) on their profile; per-group override allowed.
- Waves records the settlement with a state machine that starts at `initiated` and ends four ways: `confirmed` (payee taps "received"), `auto_confirmed` (nobody answered within 7 days — kept as its own state, not folded into `confirmed`, so "agreed" and "timed out" never read the same later), `cancelled`, and `disputed`. The last two are deliberate mirror images, one per party: only the **payer** may cancel, and only while the claim is still pending — a confirmed settlement cleared a debt somebody agreed to, and unwinding that is a new expense, not a cancel — while the **payee**'s answer to a payment they never received is to dispute it. Neither party can silently erase the other's record, and a cancel replayed from the offline queue is a no-op rather than a second activity entry. We do **not** attempt callback verification of UPI success in v1 (intent flow offers none reliably).
- **Partial and per-expense settlement is first-class** (the 985-vote gap): a settlement row can carry `allocations[] = {expense_id, amount}`; unallocated amounts apply to overall balance oldest-first. Cash/bank settlements use the same flow minus the deep link.

**Consequences.** No license, no float, no custody risk; works with every UPI app on day one. Trade-off: confirmation is social, not cryptographic — mitigated by the confirm/nudge flow, the activity log, and an optional payment screenshot the payer can attach to the settlement. The screenshot is evidence for the two people in the transfer and nobody else: the bytes are private-by-default (`visibility = 'parties'`), the read is brokered with the party check repeated at presign time and a sixty-second URL, and the proof is immutable — replacing one is a remove and a fresh attach, so a picture cannot be swapped under a settlement somebody already confirmed. International rails plug into the same settlement state machine: the rails are a **data registry** (`RailId` in `packages/core`; `settlements.rail` is a `text` column, not a hardcoded union), already spanning many markets' instant rails and consumer apps — Pix, PayNow, PromptPay, QRIS, Aani, PayID, Zelle, Venmo, Cash App, Interac, Wise, Revolut, PayPal (A27). SEPA-style bank transfers ride the generic `bank` rail rather than a named one. Opening a market is a registry entry, not type surgery.

---

## ADR-008: AI receipt itemization server-side via vision LLM

**Status:** Accepted

**Context.** 2026 table stakes; must handle receipts in any script or language a global user photographs — Indian scripts (Tamil/Hindi/regional) in the first market, plus Latin, CJK, Arabic, Cyrillic elsewhere — photos from gallery, and pasted text bills (Swiggy/Zomato/WhatsApp and their equivalents in each market) — all things Splitwise fails at. API keys must never ship in the client.

**Decision.**

- Client sends **text** where it can and the image only where it must. The phone reads the bill first with the platform's on-device recogniser (`apps/mobile/src/lib/ocr.ts`), and when that produces usable text — forty characters or more — only the text goes up, so the photograph never leaves the device and the call costs roughly a tenth of what an image costs, because a receipt photo is one to two thousand tokens before the model has read a word. A dark or blurred bill falls back to the image, which reads far better: it is presigned into private **R2** object storage (ADR-011 addendum) and the Edge Function feeds the bytes to the model itself, so no URL into our storage is ever handed out. Either way the same **Edge Function** calls the same **vision-capable LLM (Claude API)** with a strict JSON schema: `{merchant, date, currency, items[{label, qty, unit_price, total}], subtotal, taxes[], service_charge, tip, discounts[], grand_total}`; validate that items+taxes reconcile to the printed total, else flag low-confidence lines for user correction (editable review screen — AI proposes, human confirms).
- Itemized claiming: each participant taps their items on their own phone (Tab-style, realtime via Supabase Realtime); shared items split equally among claimers; **tax/tip/service prorated proportionally** to each person's item subtotal (deterministic rounding per ADR-009).
- Free tier: generous scan quota (20/month free, 300 on a paid plan, resolved by `waves_my_plan`); metered because each scan has real API cost — consistent with ADR-011 (convenience is monetizable, ledger is not). Three refusals sit in front of the model call, all server-side and all before a token is spent: a per-caller rate limit, the monthly quota, and the per-group receipt ceiling of ADR-011's addendum (`app_config.receipt_cap_per_group`). Checking the ceiling _before_ the call rather than at record time is the point — the alternative is paying for a parse the recorder would then refuse to keep.

**Consequences.** Best-in-class scan UX incl. regional scripts and text bills; per-scan cost is a COGS line to monitor; provider is swappable behind one Edge Function interface. The vision LLM reads any script the photo carries — that any-script claim is the LLM's, not the **on-device heuristic fallback** (`packages/core/src/receipt/heuristic.ts`), which is best-effort and today biased to Latin, Indic and Arabic word detection with English total/charge labels (`TOTAL`/`TAX`/`SERVICE`). Localizing that fallback's word detection and total-label matching for CJK and Cyrillic — with per-script, non-INR receipt fixtures asserting labels, amounts, detected currency and reconciliation — is a tracked follow-up, not shipped here; until then the same limits bite wherever the heuristic is the only parser — which is not, as it might sound, an offline fallback on the metered path. It is the permanent reader on the two screens that have no group to meter a scan against: a capture filed before it belongs anywhere (`apps/mobile/src/app/capture.tsx`) and the Friends one-to-one add (`apps/mobile/src/app/friends/add-person.tsx`). Those parse on the phone always, network or not, and hand back a low-confidence, user-editable result rather than a wrong one. On the group path there is no fallback at all: a scan with no network fails and says so, because a heuristic answer silently substituted for a model answer would be a worse number wearing the same confidence.

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

**Decision.** Expo Push Notifications as the primary channel; email as the second door, behind a provider seam rather than one vendor — `EMAIL_PROVIDER` selects Resend or SendGrid (`supabase/functions/_shared/email.ts`), so the account can move without the callers knowing. The seam is not symmetric and says so: SendGrid has no idempotency key, so it is refused for the queues that retry, because a send whose outcome was never learned would be delivered twice. What leaves as mail is a short list written down once (`TEMPLATE_FOR_KIND` in `packages/core/src/notifications/email.ts`) and a kind missing from it is never mailed no matter what the fanout is asked to do: settlement confirmations, the activity digest, a nudge, and being added to a group. The last two are mailed **only when there is no live device to push to** — and `group_added` also when push has spent its retries — because there is no in-app inbox any more (#565) and that is the one notification with no "check the app later" left in it. Routine ledger activity is deliberately not on the list: mailing it is the mistake that trains people to filter the sender. Defaults: push only for events **involving me** (I owe / I'm owed / I'm mentioned / settlement confirm) plus a batched group activity summary. Preferences are held per account, as one `notification_prefs` blob on the profile — per-group granularity is not built. Reminder nudges (ADR-007) are user-initiated ("nudge politely"), always visible to both parties, tone-tested to stay friendly (vasool-but-nice); the `reminders` table carries `due_date` and `auto` for scheduled auto-reminders, but nothing fires them yet.

**Consequences.** Requires a notification-preferences model and a fanout Edge Function with batching; avoids the churn-driving spam problem. Push is not fire-and-forget: a failed send is retried up to three times on an exponential backoff (`waves_finish_push`), and only once those are spent does the email half claim the row. That ordering is what makes the fallback honest — an email sent while a push was still going to arrive is the spam this ADR exists to avoid.

---

## ADR-011: Monetization guardrails (product-level ADR)

**Status:** Accepted

**Context.** Splitwise's daily cap on the core loop is the category's biggest churn engine. Waves's positioning depends on never repeating it.

**Decision.** Constitutional rules enforced in code review: **(1)** manual expense entry, groups, split types, balances, settlement recording, and export are unlimited and free, forever — no daily caps, no interstitial ads, ever. **(2)** Monetize convenience: AI scan volume beyond free quota, analytics/charts depth, auto-import (future), group/trip passes (Settle Up-style shareable premium), themes. **(3)** Regional pricing at local purchasing power in every market — never one USD price that prices out most of the world; the first market is India in INR (~₹49–99/mo tier), each new market gets its own tier. **(4)** No third-party ads in any money flow.

**Consequences.** Slower revenue early; durable trust moat and the marketing wedge ("the ledger is free forever") that the entire alternatives market currently wins with.

**Addendum (a group photo is one of the cosmetics sold).** Rule (2) lists themes among the convenience/cosmetic upsells; a **group cover photograph** is another, and is now gated the same way. A group may carry a photo if anyone in it is on a paid plan or the group holds a pass; a cover **emoji is free for everyone, always**, so a group is never left unidentifiable — only the photo is sold, never the ledger or the ability to name and find a group. Because one member cannot read another's subscription under RLS (ADR-013), "is anyone here paid" is answered by a `SECURITY DEFINER` function (`waves_can_upload_group_photo`), not the client. Consistent with rule (1): nothing about recording, splitting or settling is touched. See TDR A39.

**Addendum (image storage is R2, and free image storage has a ceiling).** Object storage moves to Cloudflare R2 (one bucket, namespaced by the old bucket name), behind a build flag (`EXPO_PUBLIC_R2_ENABLED`) and as a dual-read rather than a migration: new uploads go to R2, anything written before the cut-over is still read from Supabase Storage, and with the flag off the client writes to Supabase Storage exactly as it did. Existing bytes are never rewritten, which is what makes the change reversible one release at a time. The party-only attachment buckets are the exception — they exist only on R2, because there is no safe place for them on a backend that addresses objects by raw path. The **mobile client** reaches R2 only through the `r2-sign` edge function, so it never holds an S3 credential — every upload is a **presigned PUT**, every read a **presigned GET**; server-side code (receipt OCR, the sweep job) uses the R2 credentials directly, as it must. Storage is convenience, not the ledger, so it is monetized the same way the receipt cap (A16) already is: a **free account may hold 10 MB of image bytes** (`app_config.free_storage_cap_bytes`, an admin knob), and an upload's bytes count against the **uploader's** ceiling unless the uploader is paid **or** the group's owner is paid — a paid-owned group's **group-scoped images** (its receipts and its cover photo) are uncapped for everyone in it, while personal avatars and captures always count against their uploader. The ceiling is enforced entirely server-side (`waves_storage_reserve` at the presign, re-checked in `waves_storage_record` at the commit, both `SECURITY DEFINER` and serialised by a per-owner advisory lock, reusing `waves_group_is_paid`), because a client that could edit its own byte tally could lift its own limit (ADR-013); the presign _reserves_ the bytes so an upload that is never committed still counts, and a free account over the ceiling is refused with a 402 the app turns into an upgrade prompt. Every deleted or abandoned object is queued (`storage_orphans`) and reclaimed from R2 by the `storage-sweep` job. Images are stored as **WebP** where the device can encode it. Nothing about recording, splitting or settling is touched, and the ledger stays free forever. See TDR A44.

**Addendum (the limits are rows now, and two of them are not about the ledger).** Every ceiling this ADR permits is an admin-editable row in `app_config` rather than a number recompiled into a build — `receipt_cap_per_group`, `free_storage_cap_bytes`, `attachment_cap_per_expense`, `device_cap_free`, `device_cap_plus` — because a limit that needs a release to change is a limit nobody tunes, and the first thing a wrong limit costs is trust. Two of them deserve naming here because a reader of rule (1) would not expect them. A **free expense holds two gallery attachments** before the group must upgrade (`waves_attachment_cap`, enforced in `waves_attach_expense_attachment`); this is the same bargain as the receipt cap — images are convenience, the expense itself is not, and the amount, the split and the settlement stay free at any count. And a **guest** — someone who has not signed up at all — is held to one group and a ten-day read-only trial (`GUEST_GROUP_LIMIT` / `GUEST_TRIAL_DAYS`, ADR-006 addendum). That is a ceiling on an unclaimed account rather than on the ledger, but rule (1) says "groups … unlimited and free, forever" and this is the one place that is not literally true, so it is written down rather than discovered. Device count is capped too (`device_cap_free`, `device_cap_plus`, with A/B arms via `device_cap_*_ab`), and deliberately **softly**: `waves_register_device` still registers the device and merely reports `overLimit`, because locking somebody out of their own money on a new phone is not a limit, it is a failure.

---

## ADR-012: Data portability — full-fidelity export and competitor import

**Status:** Accepted

**Context.** Splitwise's lossy CSV + lock-in fear directly created its FOSS competitor wave.

**Decision.** Per-group and per-account export as **JSON (lossless: versions, settlements, allocations, receipt URLs)**, **CSV (locale-aware separators, includes per-person settlement detail)** and a printable **PDF**, generated by an Edge Function, free tier included. **Splitwise CSV import** ships in v1 (map members → ghosts, claimable later) as the switching on-ramp. An import may not, however, settle a debt on somebody else's word: a row the file calls paid stays paid only when the person importing can vouch for the receipt — they are the payee, or the payee is a ghost and the payer is nobody else on Waves. Every other imported settlement arrives as `initiated` and is confirmed by the member it names, exactly as a settle-up would be (ADR-007), and is dated from the moment they can first see it rather than from the file, so the auto-confirm window is theirs and not history's. A file is one person's account of a shared ledger; treating it as consent from everyone in it is how an import quietly erases a debt. Public read API deferred but schema designed for it.

**Consequences.** Trust + switching growth loop; import mapping UI is real work but directly monetizes competitor churn.

---

## ADR-013: Security via Postgres Row-Level Security + Edge Function privileges

**Status:** Accepted

**Context.** Anonymous guests, ghost claiming, and money data demand precise authorization; client code must be assumed hostile.

**Decision.** RLS on every table: membership-scoped access (`is_group_member(group_id)` security-definer function); guests are ordinary anonymous sessions with no special claims — an `authenticated` role and nothing else, authorised by the same `group_members` row as everybody, because a scope carried in a token is a second authorisation model to keep correct and the first one already works; mutations that cross privilege boundaries (expense writes, ghost claim/merge, invite minting, quota-metered AI calls, notification fanout, exports) run **only** in Edge Functions with the service role after explicit authorization checks. Receipt images in private buckets reached only through presigned URLs the server mints (`r2-sign`, ADR-011 addendum) — the client never holds a storage credential, and a service-role read that bypasses bucket policy re-checks the path against the group it just authorised, because an object path supplied by a caller is an IDOR waiting to be asked. Settlement proofs and party-only attachments are stricter still: they are brokered by subject rather than by path, so there is no path to guess. PII minimized: phone OR OAuth identity, display name, optional VPA; no contacts upload in v1. App-level biometric/PIN lock. Rate limits on invite creation and scans.

**Consequences.** Security lives in one reviewable place (SQL policies + few functions). Two gates hold it there mechanically, and both are set-shaped rather than item-shaped, because the failure they guard against is _addition_ — a new object quietly picking up a default grant that nobody wrote. `scripts/check-definer-grants.mjs` fails the static job unless every `SECURITY DEFINER` function states its caller model with a GRANT/REVOKE in the same migration; `packages/db/test/anon-surface.test.ts` pins the entire signed-out surface as exact sets (the five RLS helpers a policy must be able to evaluate, the three read-only pre-sign-in tables) and asserts a pinned `search_path` on every function in `public`. The trap is worth stating because the repo fell into it: Supabase's default privileges grant EXECUTE **directly to `anon`** as each function is created, so `REVOKE … FROM PUBLIC` does not close it — the house pattern is `FROM PUBLIC, anon`. The allow/deny matrix itself (`packages/db/test/rls.test.ts`) is hand-written per table and has no completeness check, so a new table with no policy is caught by review, not by CI. Note also that these suites live in the path-filtered `db.yml` workflow: a migration landing outside `packages/db` or `packages/core` does not trigger them.

**Addendum (a boundary-crossing mutation may run as a `SECURITY DEFINER` RPC instead of an Edge Function).** The decision routes "ghost claim/merge" through Edge Functions with the service role. The viewer-scoped guest fold (ADR-006 addendum, TDR A38) instead runs as `waves_merge_ghosts`, a `SECURITY DEFINER` Postgres function gated on the caller sharing a group with every ghost named. This is the **same trust boundary reached by a different mechanism**: authority is decided server-side under the function's owner, never in the client, and the fold writes only `ghost_merges` (owner-scoped by RLS) while touching no ledger row — so it needs no service-role privilege over money tables. An Edge Function and a definer RPC are interchangeable here precisely because both take the check out of the client; the choice is which one carries the least privilege. The service-role-only rule stands unchanged for the boundary-crossing mutations it still governs, and the largest of them is the ledger write itself: `waves_apply_expense` is granted to `service_role` alone, so an expense can only be written by `expense-write` or `sync` after they have checked the caller — while `waves_record_settlement` is granted to `authenticated`, because recording a payment you made is a claim about yourself and the ledger constraints already bound what it can do. Invite minting, quota-metered AI calls, notification fanout and exports stay on the same side as the expense write. The same pattern already backs `waves_set_member_role` (ADR-006 addendum) and the photo gate `waves_can_upload_group_photo` (ADR-011 addendum).

---

## ADR-014: Testing & quality strategy

**Status:** Accepted

**Context.** A money app with offline sync has two catastrophic failure modes: wrong balances and lost data. Both are testable.

**Decision.** **(1) Property-based tests** (fast-check) on all money math: splits sum exactly, balances sum to zero, simplification conserves pairwise net positions, FX reproducibility. **(2) Sync simulation tests:** scripted multi-device scenarios (offline edits, dupes, out-of-order replay, claim-merge races) driven through the _production_ `SyncEngine` against an in-process server that keeps exactly the two guarantees the real one is defined by — dedupe by `client_mutation_id`, recompute every share server-side — so the case two emulators would show is deterministic and runnable with no device at all. **(3) RLS policy tests** per table (allowed/denied matrices) plus a set-shaped pin on the whole signed-out surface, against a real Postgres. **(4) E2E** in two registers: Maestro flows on a real emulator against a seeded staging project, and API-level scripts that drive the deployed edge functions. Around them: edge-function handler tests, a Playwright browser smoke suite, and a merge-blocking secret scan and critical-advisory audit. Migrations are proven forward against an empty database and then diffed against `schema.prisma` — there are no down migrations, so "reversible" is a restore, not a rollback, and pretending otherwise would be the more dangerous claim.

**Consequences.** Slower first sprint, drastically cheaper every sprint after; the invariants ARE the product promise ("your waves is always right"). Two caveats worth knowing before trusting a green check. The database suites live in their own path-filtered workflow (`.github/workflows/db.yml`, triggered only by `packages/db/**` and `packages/core/**`), because they exercise SQL and split maths and a UI-only change cannot move an RLS policy — which also means a UI-only PR goes green without them having run. And the Maestro job is gated on `vars.E2E_ENABLED`, so it is a clean skip rather than a red X until the staging project and its secrets are provisioned. Both are deliberate; both mean "CI is green" is a narrower statement than it looks.

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
| 008 | On-device OCR → server vision LLM  | Text where possible, image where needed; free-quota itemization |
| 009 | Deterministic split math           | Remainder rotation; min-cash-flow suggestions                 |
| 010 | Push-first notifications           | Only-what-involves-me; email is the no-device fallback         |
| 011 | Monetization guardrails            | Ledger free forever; sell convenience                         |
| 012 | Lossless export + Splitwise import | Portability as growth loop                                    |
| 013 | RLS everywhere                     | Client assumed hostile                                        |
| 014 | Property/sync/RLS/E2E tests        | Balances provably correct                                     |
