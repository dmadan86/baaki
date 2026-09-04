# Scheduling `notify-fanout`

`notify-fanout` (TDR §7.1) claims unsent rows off `notifications`, sends push
via Expo and mail via Resend, and closes them out. Deployed as an edge
function, it does nothing on its own — something has to call it. Two things
do, and they cover different gaps:

- **A realtime trigger** (`waves_notify_fanout_on_insert`, migration
  `20260903180000_notify_fanout_realtime_trigger`) fires the instant a fresh
  row is written, so a `group_added` push or a settlement confirmation
  doesn't sit waiting on the next cron tick.
- **A `pg_cron` job**, `waves-notify-fanout`, every 5 minutes. This is the one
  a trigger structurally cannot replace: a push retry becomes due purely
  because time passed (`push_next_retry_at <= now()`), with no new row for an
  `AFTER INSERT` trigger to fire off. Belt and suspenders, not either/or.

Neither is migration-tracked for the cron job specifically, following this
project's existing convention — every `cron.job` row here (`waves-auto-archive`,
`waves-auto-confirm`, `waves-storage-expire-pending`, `waves-sweep-rate-limits`,
`waves-trip-nudges`, and this one) is set up directly against the live project
rather than in `prisma/migrations`, because a `cron.schedule()` call and the
Vault secret it reads are both environment-specific — a fresh clone or a
different Supabase project has neither, and a migration can't safely carry a
literal service-role key in checked-in SQL. The trigger's **schema** (the
function and the `CREATE TRIGGER` itself) IS migration-tracked, same as every
other trigger in this codebase — only the URL inside its body names this
project (`xvjzbpgcmotoahtqcxve`), and it no-ops harmlessly if the Vault secret
below isn't set, which is exactly what makes it safe to ship as a migration.

## One-time setup on a project that doesn't have this yet

Store the service-role key in Vault — the **new-style** `sb_secret_...` key
(`supabase projects api-keys --reveal`), not the legacy JWT, which the edge
function's own `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')` check will 401:

```sql
select vault.create_secret('<sb_secret_...>', 'service_role_key');
```

Then schedule the cron fallback (the migration above already wires the
trigger; this is the piece that isn't tracked):

```sql
select cron.schedule(
  'waves-notify-fanout', '*/5 * * * *',
  $$ select net.http_post(
       url     := 'https://<project-ref>.supabase.co/functions/v1/notify-fanout',
       headers := jsonb_build_object(
         'Authorization',
         'Bearer ' || (select decrypted_secret
                         from vault.decrypted_secrets
                        where name = 'service_role_key'),
         'Content-Type', 'application/json'
       ),
       body := '{}'::jsonb
     ) $$
);
```

Same `service_role_key` secret name the trigger reads — set it once, both
paths use it. See `docs/r2-storage.md` for the same pattern applied to
`storage-sweep`, which needs the identical one-time setup and, as of this
writing, still doesn't have its cron scheduled.
