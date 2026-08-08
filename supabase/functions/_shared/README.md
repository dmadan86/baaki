# Edge functions

Deno + TypeScript. Anything that must not run client-side lives here (ADR-002,
ADR-013): invite minting, ghost claim/merge, the AI receipt parse, notification
fanout, exports and the Splitwise import, plus the `/sync` endpoint from TDR §4.

Rules for every function in this directory:

1. **Authorize explicitly.** The service role bypasses RLS, so each function
   checks membership itself before touching a row — `is_group_member()` is the
   same predicate the policies use.
2. **Never trust client-computed money.** Shares are recomputed with
   `@baaki/core` and a mismatch is rejected with `SHARE_MISMATCH` (TDR §4).
3. **Secrets only from the function environment** — `ANTHROPIC_API_KEY`,
   `RESEND_API_KEY`, `RESEND_WEBHOOK_SECRET`, `SUPABASE_SERVICE_ROLE_KEY`.
   Nothing here may ever be referenced from `apps/*`.
4. **Idempotency.** Mutations carry `client_mutation_id`; retries must be safe.
5. **Attach ids, never rows.** Anything falling through to a 500 is sent to
   Sentry (`observability.ts`), scrubbed by `@baaki/core`. The scrubber catches
   shapes and known fields — it cannot tell a name from a word — so an error
   message must carry a code and an id, not a description. `HttpError` is never
   reported: a refusal the caller can act on is the function working.
6. **Take a rate limit before doing the expensive or revealing thing.**
   `enforceRateLimit(service, request, bucket, profileId)` from `rateLimit.ts`,
   with the allowance for every bucket in that one file. Placement is the whole
   of it: `invite-accept` counts _before_ the token lookup, because everything
   after that line is the oracle; `fx-rate` counts _after_ the cache, because a
   cache hit reaches no upstream and costs nobody anything.

   A new function is not limited because it exists — add its bucket. The one
   exception is `notify-fanout`, which is not for clients: it refuses anything
   that is not the service role, and rate-limiting our own cron would only ever
   break the cron.

Planned functions, by milestone:

| Function               | Milestone | Purpose                                                 |
| ---------------------- | --------- | ------------------------------------------------------- |
| `sync`                 | M2        | Batch mutation replay + change feed (TDR §4)            |
| `invite-mint`          | M3        | Signed, expiring, revocable invite tokens               |
| `ghost-claim`          | M3        | Transactional ghost → real member merge                 |
| ~~`splitwise-import`~~ | M3        | Shipped as `baaki_import_splitwise` instead — see below |
| `notify-fanout`        | M4        | Classify → resolve recipients → push/email (TDR §7.1)   |
| `email-events`         | M4        | Resend webhook ingestion + suppression list             |
| `receipt-parse`        | M5        | Vision LLM itemization with quota metering              |
| `export`               | M5        | Lossless JSON + locale-aware CSV, signed URL            |

## What each bucket allows

Set so that somebody using the app normally never meets one. The numbers live in
`rateLimit.ts`; this table is here so the shape is reviewable without reading it.

| Bucket          | Allowance    | Counted against | Why that number                                                         |
| --------------- | ------------ | --------------- | ----------------------------------------------------------------------- |
| `sync`          | 120 / minute | profile         | The sync engine pushes on every mutation and pulls on every foreground  |
| `expense-write` | 60 / minute  | profile         | Far above any human, well below a script                                |
| `fx-rate`       | 60 / minute  | profile         | Only the calls that miss the cache and reach an upstream                |
| `receipt-parse` | 10 / minute  | profile         | On top of the monthly quota — stops a retry loop spending it in seconds |
| `invite-mint`   | 30 / hour    | profile         | The live-link cap is per group, so somebody in many groups had none     |
| `invite-accept` | 30 / hour    | **IP address**  | Answers before anybody signs in; the reason this exists                 |
| `export-data`   | 10 / hour    | profile         | Reads a whole group and builds a file                                   |

`invite-accept` is keyed on the client address because its preview deliberately
answers before any identity exists (ADR-006) — there is no profile to blame yet.
Everything else is keyed on the profile, so a café full of users behind one NAT
is not treated as one abuser.

## Deviation: the Splitwise import is not a function

TDR §10 puts the import here and asks for a **transactional** insert. Those two
cannot both hold: a function looping over REST writes has no transaction, and a
half-finished import is the failure nobody can see — the balances still add up,
they are simply the balances of a smaller group that never existed.

So the import ships as `baaki_import_splitwise`, a single `SECURITY DEFINER`
function in the database. A function body is one transaction, which is the
property §10 was asking for. Parsing stays in `@baaki/core` and runs on the
client, so a file that turns out not to be a Splitwise export costs a round trip
to nowhere. TDR §10 wants amending to match.
