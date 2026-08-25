# Waves — self-hosted Supabase stack (the escape hatch)

This folder boots the **same open-source components** Waves runs on Supabase's
cloud — Postgres, GoTrue (auth), PostgREST, Storage, Realtime, the Edge runtime
— behind a Kong gateway that reproduces the hosted URL layout. Point the apps'
`EXPO_PUBLIC_SUPABASE_URL` at this gateway and **they run unchanged**.

Why it exists: it proves Waves is not locked to Supabase-the-company. Every
piece here is Apache-2 / MIT and runs on any Docker host — your laptop, an EC2 /
GCE / Azure VM, or a bare VPS. If Supabase's cloud ever raises prices, degrades,
or disappears, migrating off is a weekend (see [`../../MIGRATION.md`](../../MIGRATION.md)),
not a rewrite.

> This is the **infrastructure** half. Everything that makes the app portable in
> _code_ — routing all `supabase.*` calls through injected ports so a non-Supabase
> backend can be dropped in — is the separate "option A" work. This stack is
> useful on its own: it's your insurance today.

---

## What's here

| File                             | Purpose                                                        |
| -------------------------------- | -------------------------------------------------------------- |
| `docker-compose.yml`             | The stack. Image tags mirror the official self-host (2026-08). |
| `volumes/api/kong.yml`           | Gateway routing — makes `:8000` behave like the hosted API.    |
| `volumes/db/init/00-init.sh`     | One-time: aligns role passwords, ensures schemas + extensions. |
| `env.example`                    | Copy to `.env`. All stack config + how to generate keys.       |
| `functions.env.example`          | Copy to `functions.env`. Edge-function secrets.                |
| `scripts/dump-from-supabase.sh`  | Pull data out of the cloud project.                            |
| `scripts/restore-to-selfhost.sh` | Load it into this stack (or any Postgres).                     |

The Edge runtime mounts the repo's real `supabase/functions/*` read-only — no
copy, so the functions never drift from what's deployed.

---

## Boot it (laptop)

Prereqs: Docker Desktop (or Docker Engine) with Compose v2.

```bash
cd infra/self-host
cp env.example .env
cp functions.env.example functions.env          # blank is fine to start
# 1. fill POSTGRES_PASSWORD, JWT_SECRET, ANON_KEY, SERVICE_ROLE_KEY,
#    REALTIME_SECRET_KEY_BASE in .env  (see § Keys below)
docker compose up -d
docker compose ps                                 # all healthy?
```

### Keys

`ANON_KEY` and `SERVICE_ROLE_KEY` must be JWTs **signed with your `JWT_SECRET`**.
Generate both with the official tool
(<https://supabase.com/docs/guides/self-hosting/docker#securing-your-services>)
or locally:

```bash
JWT_SECRET="$(openssl rand -base64 48)"
node -e '
  const jwt=require("jsonwebtoken"), s=process.env.JWT_SECRET, now=Math.floor(Date.now()/1e3);
  const mk=r=>jwt.sign({role:r,iss:"supabase",iat:now,exp:now+10*365*24*3600},s);
  console.log("ANON_KEY="+mk("anon"));
  console.log("SERVICE_ROLE_KEY="+mk("service_role"));
' JWT_SECRET="$JWT_SECRET"
echo "JWT_SECRET=$JWT_SECRET"
```

Paste all three into `.env`. **The keys and the secret are one set** — change
`JWT_SECRET` later and you must regenerate the keys.

### Create the app schema

`public` (tables, RLS, RPCs, cron) is owned by Prisma, not this stack. After the
DB is healthy, apply the migrations against it:

```bash
# from repo root
DATABASE_URL="postgres://postgres:<POSTGRES_PASSWORD>@localhost:5432/postgres" \
DIRECT_URL="postgres://postgres:<POSTGRES_PASSWORD>@localhost:5432/postgres" \
pnpm --filter @waves/db exec prisma migrate deploy
```

---

## Smoke test (prove it works)

With the stack up and migrations applied:

```bash
BASE=http://localhost:8000
ANON=<your ANON_KEY>

# 1. PostgREST is serving under the hosted path, RLS on (empty list, not error)
curl -s "$BASE/rest/v1/groups?select=id" -H "apikey: $ANON" -H "Authorization: Bearer $ANON"

# 2. GoTrue mints an anonymous guest (ADR-006 flow) through the gateway
curl -s -X POST "$BASE/auth/v1/signup" -H "apikey: $ANON" \
  -H "Content-Type: application/json" -d '{}'
# -> a session with access_token + "is_anonymous": true

# 3. An edge function answers
curl -s "$BASE/functions/v1/fx-rate" -H "Authorization: Bearer $ANON"
```

Then point a real client at it and run the app end-to-end:

```bash
# apps/web/.env.local  (or an EAS/dev profile for mobile)
EXPO_PUBLIC_SUPABASE_URL=http://localhost:8000
EXPO_PUBLIC_SUPABASE_ANON_KEY=<your ANON_KEY>
```

Sign in as a guest, make a group, add an expense, settle. If it behaves exactly
as against the cloud — which it will — the escape hatch is proven.

Optional admin UI (Supabase Studio): `docker compose --profile studio up -d`
then <http://localhost:8100>.

---

## Going to production (server)

This compose is a **working reference, not a hardened deployment**. For a real
server add, outside the app's concern:

- **TLS** — put Caddy / nginx / a cloud LB in front of Kong `:8000`; set
  `API_EXTERNAL_URL=https://api.waves.example`.
- **Secrets** — inject `.env` from your host's secret manager, don't commit it.
- **Backups** — scheduled `pg_dump` (or a managed Postgres instead of the `db`
  container — but keep the `supabase/postgres` image or you lose `pg_net`).
- **Resource limits, log shipping, restart policies, monitoring.**

### The one real portability caveat: `pg_net`

Waves' push fan-out (`notify-fanout`, the `push_fanout` migration) calls
`pg_net` to make HTTP requests **from inside Postgres**. `pg_net` and `pg_cron`
ship in the `supabase/postgres` image, so **this stack has them**. A generic
managed Postgres (RDS, Cloud SQL, Azure DB) does **not**. So:

- Self-host on the `supabase/postgres` image (this compose): works unchanged.
- Move to vanilla managed Postgres: replace the in-DB HTTP call with an external
  worker (a small poller / queue consumer). Tracked in `MIGRATION.md`.

Everything else in `public` is standard Postgres and moves anywhere untouched.
