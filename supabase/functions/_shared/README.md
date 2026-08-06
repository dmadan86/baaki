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

Planned functions, by milestone:

| Function           | Milestone | Purpose                                               |
| ------------------ | --------- | ----------------------------------------------------- |
| `sync`             | M2        | Batch mutation replay + change feed (TDR §4)          |
| `invite-mint`      | M3        | Signed, expiring, revocable invite tokens             |
| `ghost-claim`      | M3        | Transactional ghost → real member merge               |
| `splitwise-import` | M3        | CSV → versioned expenses, unknown people as ghosts    |
| `notify-fanout`    | M4        | Classify → resolve recipients → push/email (TDR §7.1) |
| `email-events`     | M4        | Resend webhook ingestion + suppression list           |
| `receipt-parse`    | M5        | Vision LLM itemization with quota metering            |
| `export`           | M5        | Lossless JSON + locale-aware CSV, signed URL          |
