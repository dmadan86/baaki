# Durable group join link — built

Status: **built** (this PR). Validated on **local Postgres** (7 threat tests);
not deployed until an ops window (migration only — no edge change).

The industry-standard group invite (WhatsApp / Signal / Telegram / Splitwise): a
single **durable, reusable link per group**, shown as a QR by default and the
same on every open and device, with an **admin Reset** to rotate it.

## Why it needed a change

Today's `invites` are one-time-reveal — the raw token is returned once by
`invite-mint` and only its **SHA-256 hash** is stored, so a link can never be
re-shown. That is right for "share a limited invite", but it forced the QR screen
to mint a fresh link every visit. The durable model needs a **re-showable** token.

## Shape (reuses the entire existing join pipeline)

- The group keeps **one durable invite** whose raw token is stored on
  `groups.join_token` (re-showable), while an ordinary `invites` row carries its
  hash with a **100-year expiry** and an effectively unlimited use count. So
  preview / accept / ghost-claim / device-cap / guest all work on the durable
  link **unchanged** — `invite-accept` just hashes the token it receives and
  looks it up. Nothing new joins; only the link's lifecycle is new.
- `join_token` rides the normal `select('*')` group pull, so the QR **paints from
  the mirror** with no server round-trip once it exists.
- **RPCs** (migration `20260824170000_group_join_link`):
  - `waves_ensure_group_join_token(group_id)` — any member; get-or-create; returns
    the same token while it is live (stable QR).
  - `waves_reset_group_join_token(group_id)` — **admin only**; revokes the current
    durable invite (old QR dies) and mints a fresh one.
  - `waves_new_group_join_token` — internal helper (REVOKEd from clients).
- The token is a bearer credential but reaches only **members** (the group row is
  RLS-scoped). `join_token` is pinned in `waves_guard_group_columns` so a client
  can never write it directly — only the SECURITY DEFINER RPCs (which run as the
  owner and skip the guard) may.
- **pgcrypto**: SHA-256 must match the edge's plain `sha256`. The migration
  creates the `extensions` schema + pgcrypto there (a no-op on Supabase, where it
  already lives) and qualifies every call `extensions.digest` / — so resolution is
  identical on prod and on a bare test Postgres.
- **UI** — the invite screen reads `group.join_token`; the QR is there on open
  (or minted once with a brief spinner the first time a group is ever shared).
  Share / Copy / channel buttons hand out the same link. Admins get a **Reset
  link** button (confirm → rotates). i18n `durableLinkBody` / `resetLink` /
  `resetLinkBody` ×4.

## Threat tests

`packages/db/test/group-join-link.test.ts` — **T1–T7 green on local pg**: member
gets a token backed by a live 100-yr invite stored on the group; ensure is
idempotent (one invite, stable token); non-member refused; admin reset (new
token, old invite revoked, new live); non-admin reset refused; direct
`join_token` write refused (guarded column); a dead stored token is replaced on
the next ensure. The tests hash the returned token with Node's `crypto` and match
it against the stored `token_hash`, proving the accept path will resolve it.

## Deploy

Needs `db:migrate deploy` (migration `20260824170000`). **No edge change** — the
group pull is already `select('*')`, so `join_token` flows without redeploying
`sync`, and preview/accept are unchanged. Superseded the auto-mint tweak (closed
PR #414).
