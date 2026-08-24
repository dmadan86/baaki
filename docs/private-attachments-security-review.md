# Security review — private / hidden attachments + settlement proof

Status: **design + draft SQL only.** No migration is written, nothing is
deployed. This is the `/security-review` the feature plan
(`docs/travel-schema-features-plan.md` §3–§4) asked to run before any SQL lands.
Everything below validates against **local Postgres** (`pnpm db:pg:up`,
`localhost:54330`) only; prod is unreachable (stale `DIRECT_URL`, 28P01).

Scope: the `parties`-visibility attachment primitive (§3, attachment scope only)
and the settlement proof image (§4) that reuses it. The "private personal spend"
half of §3 is out of scope by design — the plan routes it to the existing
`Capture` inbox with **no ledger row and no migration**, so it has no new
authorization surface. This review covers only the restricted *attachment*.

---

## 0. TL;DR — the three highest-risk findings

1. **A restricted path must never be a column on a group-visible row.**
   Postgres RLS is *row*-level, not column-level. The sync pull
   (`supabase/functions/sync/index.ts`) reads `settlements` and
   `expense_versions` **as the caller** and returns the whole row to every group
   member (`SETTLEMENT_SELECT`, `EXPENSE_SELECT`). So a `Settlement.proof_path`
   column — as drafted in §4 — ships the R2 key to all members, and a member can
   also read it directly via PostgREST `GET /settlements?select=proof_path`. This
   is the **same class of bug as the UI-only group-photo gate** that
   `20260815180000` had to close server-side. Restricted paths must live in
   **dedicated rows** (`settlement_proofs`, `expense_attachments`) with
   party-only RLS, and must be **removed from the pull SELECTs**.

2. **A presigned GET outlives revocation.** `r2-sign` mints 1-hour presigned R2
   URLs (`URL_TTL_SECONDS = 3600`) and R2 presigns **cannot be revoked** before
   they expire. A party who is shown a proof, then the visibility is downgraded
   or they leave the group, keeps a working URL for up to an hour. Mitigation:
   a **short TTL for restricted objects** (60 s), **re-check party on every
   issue** (already the shape), and **rotate the object key on any downgrade** so
   cached URLs 404.

3. **The dual-read service-role fallback bypasses the party check.** `r2-sign`'s
   `get` action, when an object is absent from the `storage_objects` ledger,
   falls through to a **service-role** Supabase-Storage signed URL
   (`index.ts` lines 332–338) — issued with RLS bypassed. For a restricted
   bucket this would hand bytes to anyone who passed the coarse membership gate.
   Restricted buckets are **new** (no legacy objects), so this fallback must be
   **disabled** for them, paths must be **unguessable UUIDs** (no enumeration),
   and the **write** presign must check party membership, not just group
   membership.

---

## 1. Asset + trust model

### 1.1 What is sensitive

| Asset | Bucket (logical) | Sensitivity | Who may see |
| --- | --- | --- | --- |
| Settlement proof image (payment screenshot: UPI ref, bank app, card last-4) | `settlement-proofs` (new) | **High** — payment instrument + real-name identity | Payer + payee **only** (the two settlement parties) |
| Hidden expense receipt (personal bill the payer does not want the group to see) | `receipts` under a restricted prefix, or `expense-attachments` (new) | **High** — itemised personal spend | Expense **parties** (payer set) only |
| Group receipt (today's behaviour) | `receipts` | Group-shared | Any group member (unchanged) |
| Group photo / cover (today) | `group-photos` | Group-shared | Any group member (unchanged) |
| Trip album photo (§2, out of scope here) | `trip-photos` | Group-shared, but EXIF risk | Any group member |

The new tier is **`parties`** visibility: a strict subset of the group. Precedent
exists — `TripMemberBudget.visibility ∈ {'private','group'}` already hides an
owner-only row from co-members via RLS (`schema.prisma` line 1259; the pull reads
`trip_member_budgets` as caller so a private row is simply never returned). This
review extends that same pattern from "owner-only" to "parties-only".

### 1.2 The authorization predicate for each operation

Define "parties" precisely (the plan's "payer or a settlement counterparty" is
ambiguous — pin it down):

- **Settlement proof** — parties are the two members on the settlement row:
  `caller_member ∈ {from_member_id, to_member_id}`. This mirrors the existing
  `baaki_record_settlement` / `baaki_confirm_settlement` actor check
  (`v_actor NOT IN (from,to)` and `v_actor <> to`).
- **Hidden expense attachment** — parties are the **payers** of the expense's
  current version (`expense_payers`) plus the version author
  (`author_member_id`). A payer is who put money down and is the natural owner of
  the bill. (An expense has no single "payee"; using the payer set is the honest
  analogue.)

`caller_member` is the caller's own `group_members.id` for that group, derived
server-side via `baaki_my_member_id(group_id)` — never taken from the client.

| Operation | Predicate (enforced at DB **and** presign) |
| --- | --- |
| Read attachment **row** (path, meta) | `is_group_member(group_id)` AND (`visibility='group'` OR `caller is a party`) |
| Read attachment **bytes** (presigned GET) | same predicate, re-evaluated at presign time, short TTL |
| Write/replace attachment (presigned PUT + row insert) | `caller is a party` (uploader must be a party; membership alone is insufficient) |
| Set/lower `visibility` | only a party (the uploader) may set it; a non-party can neither create nor downgrade |
| Delete attachment | a party (uploader), or group admin, per existing delete conventions |

---

## 2. Threat cases — attacker steps and mitigations

### (a) Non-party member reads the row directly via PostgREST

**Attack.** A group member who is neither payer nor payee calls, under their own
JWT:
`GET /rest/v1/settlements?id=eq.<X>&select=id,proof_path` or
`GET /rest/v1/settlement_proofs?settlement_id=eq.<X>`, bypassing the app UI.

**Why the naive design fails.** If `proof_path` is a column on `settlements`,
RLS `settlements_select` (`is_group_member(group_id)`) returns the row —
including `proof_path` — to every member. RLS cannot mask one column.

**Mitigation.** No restricted path on a group-visible row. Put it in
`settlement_proofs` / `expense_attachments` whose **SELECT policy embeds the
party predicate** (SQL in §3). A non-party's PostgREST read returns **zero
rows**. Remove `proof_path` from `SETTLEMENT_SELECT` and never add a restricted
path to `EXPENSE_SELECT`.

### (b) A member who *was* a settlement party then leaves the group

**Attack.** A leaves the group after being a payee; A still holds an app session
and re-queries the proof, or replays a cached presigned URL.

**Mitigation.** `is_group_member` already returns false once `left_at` is set
(`rls_invariants` line 95), and it is the **first** conjunct of the party
predicate, so the row read denies immediately. For an already-minted presigned
URL see (c). Note the settlement `from`/`to` members are **immutable** (the row
is never re-pointed), so "was a party" can only lapse via leaving — covered by
the membership conjunct.

### (c) A presigned GET URL reused after visibility is revoked

**Attack.** Party is shown the proof (gets a 1-hour R2 presigned URL). Visibility
is downgraded to nobody, or the uploader deletes it; the attacker replays the
still-valid URL. R2 presigns are self-authenticating and **cannot be revoked**.

**Mitigations (layered):**
1. **Short TTL for restricted objects** — 60 s instead of 3600 s. The window an
   un-revocable URL survives is the TTL; cut it to seconds. (`r2-sign` must pick
   the TTL by bucket: restricted → `RESTRICTED_URL_TTL_SECONDS = 60`.)
2. **Re-check the party predicate on *every* issue** — the presign is minted only
   after `baaki_is_settlement_party` passes *now*, not from a cached grant.
3. **Rotate the object key on downgrade/party-removal** — store the R2 key with a
   random UUID segment; a visibility change writes a **new** key and orphans the
   old one (into `storage_orphans`, swept), so every previously-minted URL 404s.
   This is the only way to truly cut off an un-revocable URL early.
4. Accept and **document** the residual ≤60 s exposure to someone who held a
   valid grant moments before revocation — a bounded, logged risk.

### (d) The offline mirror leaking restricted bytes/URLs to non-viewers

**Attack.** The sync pull replicates rows to every member's device. If the
restricted row (or its path) is in a table/column that non-parties can read, the
bytes' locator lands in their local mirror even if the UI hides it — the same
"filter at render, not at source" mistake called out in the plan.

**Mitigations.**
1. Restricted rows are pulled **as the caller** (existing pattern, `pull()` reads
   every table with the caller client) so party-only RLS filters non-parties at
   the sync boundary — they never receive the row.
2. The **bytes are never in any row** — only an opaque `storage_path`. Even a
   leaked row cannot yield the image without a second gate (the presign re-check),
   so this is defense-in-depth, not the sole control.
3. `SETTLEMENT_SELECT` / `EXPENSE_SELECT` must **not** select the restricted
   path. The new tables get their own pull entries and their own mirror tables
   (§4).
4. **Realtime**: if `settlement_proofs`/`expense_attachments` are added to the
   `supabase_realtime` publication, confirm RLS is honoured on the replication
   stream (Supabase Realtime evaluates the table's RLS per subscriber). Simplest
   safe default: **do not** add them to Realtime; they arrive on the next pull.

### (e) EXIF/GPS metadata leaking a home location from a photo

**Attack.** A payment screenshot or a bill photo carries GPS EXIF; the
counterparty (or, for the album feature, the whole group) reads the uploader's
home coordinates out of the image metadata.

**Mitigations.**
1. Client strips GPS/orientation before upload (the plan's stance). But a
   modified client is untrusted, so this is a nicety, not a control.
2. The A44 pipeline already transcodes to WebP on device before upload; ensure
   the encoder path **drops metadata** (most WebP encoders emit no EXIF). Verify.
3. **Recommended follow-up:** a server-side sanitise in the `commit` HEAD path —
   re-encode/strip on the edge before the object is recorded — so metadata
   removal does not depend on the client. Not blocking for party-only proofs (the
   audience is one counterparty), but **required** before the group-visible album
   (§2) ships.

### (f) Enumeration of storage paths

**Attack.** Paths are predictable (`<settlementId>/proof.webp`); an attacker who
knows or guesses a settlement id crafts the key and asks `r2-sign get` for it, or
brute-forces the presign.

**Mitigations.**
1. **Unguessable keys** — every restricted object key includes a **random UUID**
   segment stored on the row (`settlement-proofs/<settlementId>/<randomUuid>.webp`).
   Knowing the settlement id is not enough.
2. `readPath` already rejects traversal (`..`, empty, leading slash); keep it.
3. The `get` presign authorizes against the **attachment row**, not the raw path:
   the caller names the `settlement_id`/`expense_id`, the server looks up the row
   (RLS-filtered), reads *its* stored key, and signs that — the client never
   supplies the key it wants signed for restricted buckets. This removes path
   forgery entirely.
4. `storage_objects` stays **service-role only** (`REVOKE ALL ... FROM anon,
   authenticated`, `r2_storage_cap` line 103), so the ledger cannot be scraped
   for keys.

---

## 3. Draft RLS policies + presign authorization logic

> Draft SQL for review — **not a migration.** Names follow the `baaki_*`,
> `SECURITY DEFINER`, `SET search_path`, `REVOKE ... FROM public` conventions of
> the existing migrations.

### 3.1 Party predicate helpers (SECURITY DEFINER, mirror `is_group_member`)

```sql
-- Is the caller a party to this settlement (its payer or payee)?
CREATE OR REPLACE FUNCTION public.baaki_is_settlement_party(p_settlement_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.settlements s
    JOIN public.group_members gm
      ON gm.id IN (s.from_member_id, s.to_member_id)
    WHERE s.id = p_settlement_id
      AND gm.profile_id = public.baaki_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;

-- Is the caller a party to this expense (a payer of the current version,
-- or its author)?
CREATE OR REPLACE FUNCTION public.baaki_is_expense_party(p_expense_id uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.expenses e
    JOIN public.expense_versions v ON v.id = e.current_version_id
    LEFT JOIN public.expense_payers ep ON ep.expense_version_id = v.id
    JOIN public.group_members gm
      ON gm.id = ep.member_id OR gm.id = v.author_member_id
    WHERE e.id = p_expense_id
      AND gm.profile_id = public.baaki_current_profile_id()
      AND gm.left_at IS NULL
  )
$$;

REVOKE ALL ON FUNCTION public.baaki_is_settlement_party(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_is_settlement_party(uuid)
  TO authenticated, anon;    -- used inside RLS; safe, returns only own membership
REVOKE ALL ON FUNCTION public.baaki_is_expense_party(uuid) FROM public;
GRANT EXECUTE ON FUNCTION public.baaki_is_expense_party(uuid) TO authenticated, anon;
```

### 3.2 The restricted-attachment tables

Two thin tables (kept separate rather than one polymorphic table, so each FK
cascades cleanly and each RLS predicate is unambiguous):

```sql
CREATE TABLE public.settlement_proofs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  settlement_id  uuid NOT NULL REFERENCES public.settlements(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  uploader_member_id uuid NOT NULL REFERENCES public.group_members(id) ON DELETE CASCADE,
  logical_bucket text NOT NULL DEFAULT 'settlement-proofs',
  storage_path   text NOT NULL,       -- includes a random uuid segment (non-enumerable)
  visibility     text NOT NULL DEFAULT 'parties'
                 CHECK (visibility IN ('parties')),  -- proofs are ALWAYS party-only
  updated_seq    bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  UNIQUE (settlement_id)              -- one proof per settlement (v1)
);

CREATE TABLE public.expense_attachments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  expense_id     uuid NOT NULL REFERENCES public.expenses(id) ON DELETE CASCADE,
  group_id       uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
  uploader_member_id uuid NOT NULL REFERENCES public.group_members(id) ON DELETE CASCADE,
  logical_bucket text NOT NULL DEFAULT 'expense-attachments',
  storage_path   text NOT NULL,
  visibility     text NOT NULL DEFAULT 'group'
                 CHECK (visibility IN ('group','parties')),
  updated_seq    bigint NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz
);

ALTER TABLE public.settlement_proofs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_attachments ENABLE ROW LEVEL SECURITY;
```

### 3.3 The RLS policies — party enforcement at the DB

```sql
-- Settlement proof: readable only by a party. Membership is implied by party-ship
-- (a party is a live member), but keep it explicit as the outer guard so a left
-- member is denied even if the party join somehow matched.
CREATE POLICY settlement_proofs_select ON public.settlement_proofs
  FOR SELECT TO authenticated, anon
  USING (
    public.is_group_member(group_id)
    AND public.baaki_is_settlement_party(settlement_id)
  );

-- Only a party may create the proof, and only for a settlement they belong to.
CREATE POLICY settlement_proofs_insert ON public.settlement_proofs
  FOR INSERT TO authenticated, anon
  WITH CHECK (
    public.is_group_member(group_id)
    AND public.baaki_is_settlement_party(settlement_id)
    AND uploader_member_id = public.baaki_my_member_id(group_id)
  );

CREATE POLICY settlement_proofs_delete ON public.settlement_proofs
  FOR DELETE TO authenticated, anon
  USING (
    public.baaki_is_settlement_party(settlement_id)
  );
-- No UPDATE policy: a proof is immutable; replacing it is delete + insert with a
-- fresh key, which also gives key-rotation (threat (c)) for free.

-- Expense attachment: a 'group' row is visible to any member; a 'parties' row
-- only to the payers/author.
CREATE POLICY expense_attachments_select ON public.expense_attachments
  FOR SELECT TO authenticated, anon
  USING (
    public.is_group_member(group_id)
    AND (
      visibility = 'group'
      OR public.baaki_is_expense_party(expense_id)
    )
  );

CREATE POLICY expense_attachments_insert ON public.expense_attachments
  FOR INSERT TO authenticated, anon
  WITH CHECK (
    public.is_group_member(group_id)
    AND public.baaki_is_expense_party(expense_id)
    AND uploader_member_id = public.baaki_my_member_id(group_id)
  );

CREATE POLICY expense_attachments_delete ON public.expense_attachments
  FOR DELETE TO authenticated, anon
  USING (public.baaki_is_expense_party(expense_id));
```

Note: the tables are written **directly by the caller** (RLS gates it), not via a
service-role RPC, exactly as `captures` and `trip_member_budgets` are. The
`storage_objects` ledger row for the bytes stays service-role-only through
`r2-sign` as today.

### 3.4 Presign authorization — the `r2-sign` branch (pseudo-code)

The presign must **repeat** the DB party check (defense in depth: the row read
and the byte read are two doors, both must be party-gated). Mirror the
photo-gate server enforcement.

```ts
// _shared/r2.ts — register the new buckets and mark which are "restricted".
export const LOGICAL_BUCKETS = [
  'receipts', 'group-photos', 'avatars', 'captures',
  'settlement-proofs', 'expense-attachments',
] as const;
const RESTRICTED_BUCKETS = new Set(['settlement-proofs', 'expense-attachments']);
const RESTRICTED_URL_TTL_SECONDS = 60;   // threat (c): short-lived, un-revocable
```

```ts
// index.ts — authorizeRead, new branch for restricted buckets.
// The client names the SUBJECT (settlementId / expenseId), NOT the raw key
// (threat (f)); the server looks up the row under RLS and signs its stored key.
async function authorizeRestrictedRead(caller, service, bucket, subjectId) {
  // Read the attachment row AS THE CALLER so RLS applies the party predicate.
  const table = bucket === 'settlement-proofs' ? 'settlement_proofs'
                                                : 'expense_attachments';
  const subjectCol = bucket === 'settlement-proofs' ? 'settlement_id' : 'expense_id';
  const { data: row } = await caller
    .from(table)
    .select('storage_path, logical_bucket')
    .eq(subjectCol, subjectId)
    .is('deleted_at', null)
    .maybeSingle();
  if (!row) throw new HttpError(403, 'NOT_VISIBLE', 'Not visible to you');
  return row.storage_path;   // the real key to sign
}
```

```ts
// The 'get' action for a restricted bucket:
if (RESTRICTED_BUCKETS.has(bucket)) {
  const path = await authorizeRestrictedRead(caller, service, bucket, body.subjectId);
  // No Supabase-Storage dual-read fallback (threat (3)/(f)): restricted buckets
  // are new, every object is in R2. If the ledger has no row, it does NOT exist.
  const getUrl = new URL(objectUrl(bucket, path));
  getUrl.searchParams.set('X-Amz-Expires', String(RESTRICTED_URL_TTL_SECONDS));
  const signed = await r2().client.sign(new Request(getUrl), { aws: { signQuery: true } });
  return json({ url: signed.url });
}
```

```ts
// authorizeWrite — restricted PUT/commit: party-only, not membership-only.
if (RESTRICTED_BUCKETS.has(bucket)) {
  const subjectId = requireSubject(body);           // settlementId / expenseId
  const groupId   = await groupOfSubject(service, bucket, subjectId);
  await requireMembership(caller, groupId);
  const isParty = bucket === 'settlement-proofs'
    ? await caller.rpc('baaki_is_settlement_party', { p_settlement_id: subjectId })
    : await caller.rpc('baaki_is_expense_party',     { p_expense_id: subjectId });
  if (isParty.data !== true) throw new HttpError(403, 'NOT_A_PARTY', 'Only a party may attach proof');
  return { groupId };
}
```

Key properties: (1) the party check is **server-side and repeated at the
presign**, never the client's word; (2) restricted GET TTL is 60 s; (3) no
dual-read fallback for restricted buckets; (4) the client never supplies the key
to sign for a read — it supplies the subject id and the server resolves the key
under RLS.

---

## 4. Mirror / sync changes

The restricted attachment must be filtered at the **sync boundary**, not the
render layer (plan §3, threat (d)).

1. **Remove restricted paths from the group-wide SELECTs.** Do **not** add a
   `proof_path` column to `settlements`, and do **not** add a restricted
   attachment path to `EXPENSE_SELECT`/`expense_versions`. (The existing
   group-shared `receipt_share_url` stays — it is intentionally group-visible.)

2. **Add two new pull tables, read as the caller.** In `pull()` add
   `settlement_proofs` and `expense_attachments` to the per-group table loop
   (same shape as `trip_member_budgets`), each `.eq('group_id', groupId)
   .gt('updated_seq', since)`. Because the pull uses the **caller** client, the
   party RLS filters non-parties automatically — a non-party's response simply
   omits the rows. Requires an `updated_seq` bump path (a trigger like the other
   synced tables) so the cursor advances.

3. **Add mirror tables + materialisers.** In `packages/core/src/sync/mirror.ts`:
   add `SyncTable.SettlementProofs` and `SyncTable.ExpenseAttachments` to
   `TABLES`, plus `MirrorSettlementProof` / `MirrorExpenseAttachment` interfaces
   and `materialise*` functions (pull-only, or with a pending overlay if the
   client can attach offline). The row carries only `storage_path`; the bytes are
   resolved lazily through `r2-sign get`, which re-checks the party predicate —
   so even a bug that mirrored a row to the wrong device cannot surface the
   image.

4. **Do not put these tables in the `supabase_realtime` publication** (or, if
   Realtime is wanted, verify per-subscriber RLS on the stream). The pull is the
   safe default.

5. **Cursor-existence caveat (documented, low risk).** The group's global
   `updated_seq` advances when a restricted row is written, so a non-party can
   infer *that something changed*, but never *what* — no row, no path, no bytes
   reach them. Acceptable.

---

## 5. Go / no-go checklist — RLS threat tests (must be green on local pg)

Add `packages/db/test/private-attachments.test.ts`, in the style of
`rpc-boundary.test.ts` / `rls.test.ts` (JWT-claim + `SET LOCAL ROLE`, rolled
back). Ships only when **all** are green:

- [ ] **T1** Non-party member SELECT on `settlement_proofs` for a party-only row → **0 rows**.
- [ ] **T2** Payer SELECT and payee SELECT of the same proof → **1 row each**.
- [ ] **T3** `expense_attachments` with `visibility='group'` → **every member** sees it.
- [ ] **T4** `expense_attachments` with `visibility='parties'` → only payer(s)/author see it; a non-payer member → **0 rows**.
- [ ] **T5** A former party whose membership `left_at` is set → **0 rows** (membership conjunct).
- [ ] **T6** `role=anon` (no `sub`) SELECT on either table → **0 rows**.
- [ ] **T7** Outsider from a different group → **0 rows**.
- [ ] **T8** Non-party INSERT of a proof (party check in `WITH CHECK`) → **denied**.
- [ ] **T9** Party INSERT with a **forged** `uploader_member_id` (someone else's) → **denied** (`uploader_member_id = baaki_my_member_id`).
- [ ] **T10** After an expense edit drops a member from `expense_payers`, that member loses SELECT on a `parties` attachment → **0 rows** (predicate is re-evaluated live).
- [ ] **T11** `storage_objects` still `REVOKE ALL FROM anon, authenticated` — a client SELECT → **denied** (no key scraping).
- [ ] **T12** Assert the **sync pull shape**: `SETTLEMENT_SELECT` returns no `proof_path`; a non-party's pull of the group returns no `settlement_proofs`/`expense_attachments` rows.
- [ ] **T13** `baaki_is_settlement_party` / `baaki_is_expense_party` return **false** for a non-party and **true** for each party (unit).
- [ ] **T14** Delete then re-insert (key rotation) yields a **different** `storage_path` (threat (c) rotation invariant).

Presign-layer checks (edge, or asserted via the helper RPCs in T13 since the
edge repeats them): non-party `r2-sign get` → 403; restricted GET TTL == 60 s;
restricted bucket has **no** Supabase-Storage fallback.

---

## 6. ADR conflicts and required amendments

- **ADR-006 (privacy)** — the binding model is "everything in a group is visible
  to all members". A `parties` tier is a new **sub-group** visibility boundary.
  Precedent already exists (`TripMemberBudget` `private`/`group`), so this is an
  **addendum extending that precedent to attachments**, defining the `parties`
  audience (settlement: from/to; expense: payers+author) and stating the
  enforcement is RLS + presign, never the client. **Amendment required.**

- **ADR-007 (settlement)** — currently proof is note-only + payee confirm. This
  adds an **image proof that is party-only, never group-visible**, and is
  immutable (delete + re-add to replace). **Amendment required**: record that
  proof visibility is strictly the two parties, and that a proof is evidence
  attached to — not a precondition of — confirmation.

- **ADR-005 (offline mirror)** — consistent, no amendment: restricted rows ride
  the mirror but are filtered at the sync boundary by caller-scoped RLS, and the
  bytes never enter a mirror row. Worth a one-line note that the byte fetch is a
  second, re-checked gate.

- **ADR-013 (read-as-caller / definer-RPC boundary)** — consistent, no
  amendment: the pull reads as caller (so RLS filters), writes to the attachment
  tables go through caller-scoped RLS, and the byte ledger stays service-role.
  The presign repeating the party check is the same "authorize, then act as
  service" shape ADR-013 prescribes.

- **ADR-011 / A44 (R2 storage)** — the two new logical buckets extend the R2
  ledger + cap; restricted objects count against the cap like any other. The
  new constraint on top of A44 is the **short TTL + no dual-read fallback** for
  restricted buckets. No conflict; note it in the R2 ADR.

---

## 7. Build sequence (unchanged from the plan, with the gates this review adds)

1. Land the two helper functions + tables + RLS behind a flag; **T1–T14 green on
   local pg** before any UI.
2. `r2-sign` restricted branches (short TTL, no fallback, party check) + the
   subject-not-key read contract.
3. Sync/mirror wiring (new pull tables, mirror materialisers, `SETTLEMENT_SELECT`
   unchanged / no `proof_path`).
4. Settlement proof UI (§4) reuses all of the above.
5. ADR-006 + ADR-007 amendments recorded in the same PR series.

Nothing deploys until an ops window restores the prod DB password and a
coordinated `db:migrate` + `edge:deploy` runs.
