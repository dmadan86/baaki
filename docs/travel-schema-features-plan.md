# Travel features — schema-heavy set (design + security plan)

Status: **planned, not built.** The rest of the travel-gap work shipped as
no-schema PRs (#395–#400). The four features below each need a **migration**,
and three of them touch **privacy/RLS**, so they are specced here before any
SQL is written. None of these can be deployed to prod right now — the prod
`DIRECT_URL` password in `packages/db/.env` is stale (28P01), so migrations
validate against **local Postgres** (`pnpm db:pg:up`, `localhost:54330`) only
until an ops window reconnects prod. Build behind a flag where possible; do not
run `edge:deploy` / `db:migrate` as part of these PRs.

Money rules that constrain all four: **bigint minor units**, **currencies never
mix (ADR-003/004)**, **server never trusts a client-sent share (TDR §4)**,
**offline-first mirror (ADR-005)** — a new user-editable table needs a mirror
path or an explicit online-only justification.

---

## 1. Category budgets (food / stays / transport / …)

**Value:** per-category caps beside the existing overall + per-member trip
budgets on `plan.tsx`. Lowest risk of the four — no privacy surface, reuses the
audited `budgetProgress`.

**Schema draft**

```prisma
model TripCategoryBudget {
  id         String   @id @default(uuid()) @db.Uuid
  groupId    String   @map("group_id") @db.Uuid
  // A built-in category key or a custom CategoryTag id (see category_meta).
  category   String
  amountMinor BigInt  @map("amount_minor")
  currency   String   @db.Char(3)
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  group      Group    @relation(fields: [groupId], references: [id], onDelete: Cascade)

  @@unique([groupId, category, currency])
  @@map("trip_category_budgets")
}
```

**RLS:** identical to `trip_member_budgets` — a group member reads/writes rows
for their group; only an admin sets a _group-wide_ category cap (mirror the
overall-budget admin gate already in `plan.tsx`). No per-member visibility knob
(category caps are a group signal, not personal).

**Core:** no new math. Reduce spend per `(category, currency)` from the shares
already in the ledger, then `budgetProgress(cap, spentByCategoryCurrency)` per
row — `spendByMember`'s sibling, `spendByCategory`, is a ~15-line addition to
`trip/budget.ts` with a property test that a category's spend never exceeds the
group total.

**UI:** a "Category budgets" section on `plan.tsx` under the existing budgets
card; one `BudgetBar` per category with its `CategoryBadge`. i18n: reuse
`t.categories`; add `categoryBudgets` label ×4 langs.

**Mirror:** add to the offline mirror the same way member budgets ride it.

**Deviation:** TDR budget section names overall + per-member only — amend to add
the category dimension. Effort: **S** (1 migration, ~1 core fn, 1 UI section).

---

## 2. Shared album (photos linked to expenses / the trip)

**Value:** the "memory layer" — photos attached to meals/activities, browsable
as a trip album. Distinct from the single group cover photo and from a receipt.

**Schema draft** (reuses the R2 `StorageObject` ledger + cap, ADR on R2)

```prisma
model TripPhoto {
  id         String   @id @default(uuid()) @db.Uuid
  groupId    String   @map("group_id") @db.Uuid
  // Optional link to the expense/day this photo belongs to.
  expenseId  String?  @map("expense_id") @db.Uuid
  day        DateTime? @db.Date
  storagePath String  @map("storage_path")   // R2 object, private bucket
  uploaderId String   @map("uploader_id") @db.Uuid
  caption    String?
  createdAt  DateTime @default(now()) @map("created_at") @db.Timestamptz(6)
  deletedAt  DateTime? @map("deleted_at") @db.Timestamptz(6)  // tombstone (ADR-005)

  @@index([groupId, day])
  @@map("trip_photos")
}
```

**Storage / cap:** new logical bucket `trip-photos`; goes through the existing
`r2-sign` presign → `baaki_storage_reserve`/`record` cap path so album photos
count against the free-tier storage cap exactly like receipts. Uploader-or-owner
paid-bypass follows the R2 cap rules already in place.

**Security:** private bucket; a `get` presign is authorized only for a group
member (same check `r2-sign` already does for receipts). Deletion is a
soft-delete tombstone; the sweep job reclaims R2 bytes. **No EXIF stripping
today** → strip GPS/orientation client-side before upload (privacy: a beach
photo should not leak a home address in metadata).

**Core:** none (it's storage + a list). **UI:** an album grid on the group/trip
screen and a photo strip on the expense detail; add-photo reuses the R2 client
helper. i18n ×4.

**Deviation:** new capability, needs a short ADR (album vs receipts vs cover —
three different photo concepts). Effort: **M** (migration + bucket + RLS + 2 UI
surfaces + EXIF strip).

---

## 3. Private in-group expense + hidden attachments

**Value:** track a personal spend inside a shared trip that others should not
see; hide a payment screenshot to payer/payee only. **Highest risk — this is a
privacy boundary, and a leak is a real-world harm.** Do this one slowest.

**Design tension:** the whole ledger is built on _shared_ balances. A truly
private expense that moves **no one else's balance** is really the existing
`Capture` inbox (personal, un-assigned) — recommend routing "just mine" there
rather than inventing a hidden ledger row that the balance math must then learn
to skip. A hidden row that _does_ affect balances cannot be truly private
(others can back it out from the totals), so the honest scope is:

- **Private personal spend** → surface the existing personal `Capture`/own-cloud
  path in the trip context; no new hidden ledger row. **No migration.**
- **Hidden attachment** → a `visibility` flag on the _attachment_, not the
  expense: the expense and its amount stay shared (balances are honest), only
  the image is restricted.

**Schema draft** (attachment visibility only)

```prisma
// on Receipt / a new ExpenseAttachment
visibility  String  @default("group")   // 'group' | 'parties'  (payer+payee)
```

**Security (must-haves):**

- Enforce at **RLS + presign**, never in the client. A `parties`-visibility
  attachment's `get` presign is authorized only if the caller is the payer or a
  settlement counterparty — mirror the server-side photo-gate enforcement
  pattern already used for group photos (UI-only gating was a bypass before and
  must not recur).
- The mirror must **not** replicate a restricted attachment's bytes/URL to
  members who cannot see it — filter at the sync boundary, not the render layer.
- Threat cases to test: non-party member reads the row directly via PostgREST;
  a member who _was_ a party then left; a presigned URL reused after visibility
  changes (short TTL + re-check on issue).

**Deviation:** touches ADR-006/privacy + the RLS model — needs an ADR addendum
and a dedicated security review (this is the one to run `/security-review` on).
Effort: **L**, gated behind a flag, shipped only after the RLS threat tests are
green on local pg.

---

## 4. Settlement proof image

**Value:** attach a payment screenshot to a settlement and let the payee
confirm — a stronger "it's paid" than the current note-only confirm (ADR-007
already has payee confirmation; this adds evidence).

**Schema draft**

```prisma
// on Settlement
proofPath   String?  @map("proof_path")   // R2 object, private bucket
```

**Storage:** `settlement-proofs` bucket via the R2 presign + cap path. **A
settlement proof is inherently sensitive** — visible to **payer and payee
only**, never the whole group (this is exactly the `parties` visibility rule
from #3, so build #3's attachment-visibility enforcement first and reuse it).

**Core:** none (settlement state machine already has `confirmed`). **UI:** an
attach-proof control on the settle screen and a view-proof affordance for the
counterparty on the settlement row. i18n ×4.

**Deviation:** extends ADR-007 (proof as evidence, party-only visibility).
Effort: **S–M**, but **depends on #3's party-visibility + presign enforcement**.

---

## Build sequence

1. **Category budgets** (#1) — independent, low risk, ship first.
2. **Attachment visibility + RLS/presign enforcement** (#3, attachment scope
   only) — the security primitive the others reuse; security-review gated.
3. **Settlement proof** (#4) — reuses #3.
4. **Shared album** (#2) — independent of #3/#4; needs EXIF strip + bucket.
5. Private _personal_ spend → route to existing Capture, no schema.

Each lands as its own PR with the migration validated on local Postgres
(`pnpm db:pg:up` → `pnpm db:migrate:dev` → `pnpm db:drift` clean → `pnpm
test:db`), behind a feature flag, and **not** deployed until an ops window
restores the prod DB password and an `edge:deploy` + `db:migrate` run is
coordinated.

---

## Status — all built

- **#1 Category budgets** — PR #405 (merged). `category_budgets` on the group,
  admin-gated via `baaki_guard_group_columns`.
- **#3 Attachment visibility (`parties`) + RLS/presign** — PR #407 (merged).
  Security review in `private-attachments-security-review.md`; 16 threat tests.
- **#4 Settlement proof** — schema/hooks in #407, UI in PR #408 (merged). Payer
  attaches on a synced settlement, payee views before confirming.
- **#2 Shared album** — PR #406 (merged). `trip_photos`, `trip-photos` bucket,
  EXIF-stripped upload, album grid + expense strip.
- **#5 Private personal spend** — built (this PR), **no schema**. A "Just for me"
  affordance on the group add-expense screen routes the typed amount/note into
  the personal captures inbox (`/capture`, `targetGroupId` stays null), which
  never touches a group balance. No hidden ledger row was invented, per the
  design tension above — a truly private spend that moves no one else's balance
  _is_ the existing capture, so the honest change is a contextual doorway to it.

The schema-carrying features (#1–#4) remain **deploy-gated**: their migrations
(`20260824130000`, `20260824140000`, `20260824150000`) + `sync`/`r2-sign` edge
await the same ops window (prod `DIRECT_URL` password stale, 28P01). #5 carries
no migration and no edge change, so it has nothing to deploy.
