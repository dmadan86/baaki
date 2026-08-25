#!/bin/bash
# Runs ONCE, on an empty data volume, before anything connects.
#
# The supabase/postgres image already creates the platform roles (anon,
# authenticated, service_role, authenticator, supabase_auth_admin,
# supabase_storage_admin, supabase_admin, ...). Two things still need doing
# per-deployment, both idempotent:
#   1. set those roles' passwords to POSTGRES_PASSWORD so GoTrue / PostgREST /
#      Storage can authenticate with the one secret from .env;
#   2. ensure the schemas GoTrue / Storage / Realtime own exist, so their own
#      boot migrations land in the right place.
#
# Waves' public schema (tables, RLS, RPCs, cron) is NOT created here — Prisma
# owns it (packages/db). After the stack is up, run the migrations against it;
# see infra/self-host/README.md.
set -euo pipefail

psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<-SQL
  DO \$\$
  BEGIN
    -- (1) Align role passwords with POSTGRES_PASSWORD.
    ALTER ROLE authenticator          WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
    ALTER ROLE supabase_auth_admin    WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
    ALTER ROLE supabase_storage_admin WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
    ALTER ROLE supabase_admin         WITH LOGIN PASSWORD '${POSTGRES_PASSWORD}';
  EXCEPTION WHEN undefined_object THEN
    RAISE NOTICE 'a platform role was missing; image may differ — check supabase/postgres tag';
  END
  \$\$;

  -- (2) Schemas the services own (safe if the image already made them).
  CREATE SCHEMA IF NOT EXISTS auth      AUTHORIZATION supabase_auth_admin;
  CREATE SCHEMA IF NOT EXISTS storage   AUTHORIZATION supabase_storage_admin;
  CREATE SCHEMA IF NOT EXISTS _realtime AUTHORIZATION supabase_admin;

  -- Extensions Waves migrations require. pg_net + pg_cron ship in the
  -- supabase/postgres image; they will NOT exist on stock RDS/Cloud SQL.
  CREATE EXTENSION IF NOT EXISTS pgcrypto  WITH SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS pg_net    WITH SCHEMA extensions;
  CREATE EXTENSION IF NOT EXISTS pg_cron;
SQL

echo "waves self-host: roles aligned, schemas + extensions ensured."
