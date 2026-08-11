# Baaki Web — full-featured web app

**Goal.** Grow `apps/web-lite` from the deliberate guest/link "lite" view
into a full web client with parity to the mobile app, styled after the
pastel dashboard reference (soft gradient stat cards, top-nav tabs, a
right-hand detail panel, rounded surfaces).

**Auth.** Google OAuth for real users; anonymous-guest + invite links stay.
Google is already the ADR-named upgrade provider (ADR-006: "phone-OTP/
Google/Apple"), so it is **in-scope, not a deviation**.

---

## Deviation to record (ADR-006)

ADR-006 scopes the browser experience as a **"read-write web-lite group
view"** — one invited group, upsell the app. This plan turns it into a
**full multi-group web client**. That is a product-scope expansion, not a
correctness change:

- Guest ceilings (ADR-006 addendum) are **unchanged** — `guestGate` in
  `@baaki/core` still gates one-group / ten-day writes; the web UI must
  honour it exactly as mobile does (disable writes, prompt sign-up).
- All writes still go through the same Edge Functions (server recomputes;
  client numbers are a claim — TDR §4). No new trust granted to the browser.
- RLS unchanged (ADR-013): the app shows only what the session may read.

**Action:** add an ADR-006 addendum ("Web is a full client, not lite")
in the same PR that ships Phase 1, so the doc and the code agree.

---

## Architecture

- **Reuse, don't fork.** Keep `@baaki/api-client` (framework-free) as the
  single browser data layer. It currently exposes only
  `group/members/expenses/settlements + writeExpense + invite`. The mobile
  app's `src/data/api.ts` holds ~70 functions against the same Postgres +
  Edge Functions. Port the read/write surface web needs **into
  `@baaki/api-client`** (not into the Next app), so both stay honest about
  who owes what. Split maths/balances/categories already live in
  `@baaki/core` and are used as-is.
- **No offline mirror / mutation queue on web** (by design — client.ts
  says so). Web reads live via PostgREST, writes live via Edge Functions.
  `@tanstack/react-query` for cache/refetch (already a mobile dep).
- **Next 16 App Router**, React 19, client components for data screens
  (RLS runs under the browser session). Read
  `node_modules/next/dist/docs/` before writing — this Next is patched.
- **Design system:** a small web UI kit under `apps/web-lite/src/ui/`
  (tokens + primitives) mirroring `@baaki/ui`'s vocabulary (Card, StatCard,
  Row, Avatar, Button, Gradient, SegmentedTabs, DetailPanel) — CSS, no RN.
  Tokens track the reference: warm paper background, gradient tint cards
  (peach/blue/lilac/rose), ink/inkMuted text, raspberry money-red, green
  owed. Honour existing bold-card + UX/color-audit decisions from mobile.

---

## API-client gaps to fill (grouped)

Ported from `apps/mobile/src/data/api.ts`, added to `@baaki/api-client`:

- **Home/dashboard:** `fetchGroups`, `fetchMyBalances`, `fetchAllBalances`,
  `fetchPeopleBalances`, `fetchRecentActivity`, `fetchPendingSettlements`,
  `fetchSettledTotals`, `fetchMembersByGroup`.
- **Group:** `fetchActivity`, `fetchBalances`, `fetchGroupSpending`,
  `createGroup`, `updateGroup`, `updateMember`, `leaveGroup`,
  `addGhostMember`.
- **Expenses:** `deleteExpense`, `restoreExpense`, `fetchExpenseVersions`
  (writeExpense already present).
- **Settle:** `recordSettlement`, `confirmSettlement`, `nudgeToSettle`.
- **Disputes:** `fetchDisputes`, `disputeExpense`, `withdrawDispute`,
  `resolveDispute`.
- **Invite/claims:** `mintInvite`, `revokeInvite`, `fetchMemberClaims`,
  `decideMemberClaim`, `fetchMyClaims`, `withdrawMemberClaim`
  (preview/accept already present).
- **Plan / itemize / receipts:** `fetchPlanItems`, `addPlanItem`,
  `setPlanItemDone`, `removePlanItem`, `fetchOpenReceipts`, `fetchReceipt`,
  `fetchItemClaims`, `setItemClaim`, `publishReceiptItems`,
  `scanReceiptText` (text path only — no on-device OCR in browser).
- **Notifications/inbox:** `fetchNotifications`, `markNotificationsRead`,
  `fetchNotificationPrefs`, `saveNotificationPrefs`.
- **Settings/account:** `exportData`, `importLedger`, `redeemPromoCode`,
  `submitFeedback`, `fetchDevices`, `signOutOtherDevices`,
  `erasurePreview`, `deleteMyAccount`, contact add/confirm.
- **Photos:** `uploadGroupPhoto`/`groupPhotoUrl`/`removeGroupPhoto`,
  avatar equivalents (Supabase Storage — works in browser).
- **Auth:** add `signInWithGoogle()` (OAuth redirect) + `signOut()` +
  `session()` to the client; keep `signInAsGuest`.

Each ported function gets a unit test mirroring the existing
`api-client/test/ledger.test.ts` style where it carries logic.

---

## Screen inventory & phasing

Legend: ✳ new web screen · ↺ reskin existing web-lite page.

### Phase 1 — Shell, auth, dashboard

- ✳ App shell: top nav (Overview · Groups · Activity · Friends · Settle),
  global search, notifications bell, profile avatar menu. Responsive:
  tabs collapse to a bottom bar on narrow screens.
- ✳ Sign-in screen: "Continue with Google" + "open an invite link as
  guest". Google OAuth redirect handler route (`/auth/callback`).
- ✳ **Overview dashboard** (the reference screenshot, adapted):
  gradient stat cards (You're owed / You owe / This month / Groups),
  group list with per-group net, recent activity feed, right-hand detail
  panel (selected group / person summary). Real data via new client fns.
- Deliverable: signed-in user sees their real groups + balances on web,
  styled like the design. Guest ceiling honoured. + ADR-006 addendum.

### Phase 2 — Group detail & expenses

- ↺ Group page: balances, who-pays-whom, expense list — reskinned to
  cards + detail panel; add member/ghost.
- ✳ Expense detail (versions, dispute) · ✳ Add/Edit expense (all split
  types via `@baaki/core`) — reskin of the current `/add` page.

### Phase 3 — Settle, friends, activity

- ✳ Settle-up (record + confirm settlement, UPI intent link per ADR-007,
  nudge) · ✳ Friends / people balances · ✳ Activity feed (group + global)
  · ✳ Inbox/notifications.

### Phase 4 — Insights, plan, itemize, import/export, settings

- ✳ Group insights/spending · ✳ Month view · ✳ Trip plan (checklist)
  · ✳ Receipt itemize + claims (text scan only) · ✳ Import (Splitwise/
  Baaki CSV) + Export · ✳ Settings (account, language, notifications,
  privacy, devices, upgrade, redeem, delete-account, feedback).

---

## Cross-cutting

- **i18n:** web already has `src/i18n.ts` + context; grow the string set
  screen-by-screen (mobile has full coverage to mirror). RTL: web can flip
  with `dir` on `<html>` at request time — simpler than the native restart
  constraint; still drive icon direction from `dir`.
- **Guest ceilings:** call `guestGate` from `@baaki/core` in every write
  path's UI (disable + upsell), matching mobile. Server still enforces.
- **Observability:** Sentry (`@sentry/nextjs`) already wired; keep.
  Clarity optional, behind the same consent toggle mobile uses.
- **Testing:** vitest for ported client fns + i18n + money, as today.
  `pnpm --filter @baaki/web-lite lint|typecheck|test` green per PR.

## Delivery

- One PR per phase (never to `main` directly), each independently
  shippable and reviewable. Phase 1 PR also carries the ADR-006 addendum.
- Rename note: keep the folder `web-lite` for now (no infra churn); the
  ADR addendum records that "lite" is historical. Optional later rename to
  `apps/web` in its own PR.

## Open questions before Phase 1

1. Keep the `web-lite` folder name, or rename to `apps/web` now?
2. Currency display on the Overview when a user's groups span currencies —
   one row per currency (mobile does this), confirm same on web.
3. Search scope on day one — groups + people only, or expenses too?
