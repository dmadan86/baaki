#!/usr/bin/env bash
# Load the dumped data into a self-host (or any target) Postgres.
#
# ORDER MATTERS. Before running this:
#   1. the self-host stack is UP (docker compose up -d), so GoTrue has created
#      the `auth` tables and the platform roles exist;
#   2. Prisma migrations have been applied to TARGET_DB_URL, so `public`
#      structure (tables, RLS, RPCs, cron) exists and is empty.
# Then this loads auth users first (so profile FKs resolve) and public data.
#
# Usage:
#   export TARGET_DB_URL="postgres://postgres:PASSWORD@localhost:5432/postgres"
#   ./restore-to-selfhost.sh ./out
set -euo pipefail

: "${TARGET_DB_URL:?export TARGET_DB_URL=the target Postgres connection URI}"
IN="${1:-./out}"
[ -f "$IN/auth.sql" ]   || { echo "missing $IN/auth.sql — run dump-from-supabase.sh first"; exit 1; }
[ -f "$IN/public.sql" ] || { echo "missing $IN/public.sql"; exit 1; }

echo "==> auth users + identities (UUIDs preserved)"
# --single-transaction: all-or-nothing here too, so a mid-load failure leaves
# no half-populated auth schema for the public restore below to build FKs onto.
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction -f "$IN/auth.sql"

echo "==> public data"
# --single-transaction: all-or-nothing, so a mid-load failure leaves no
# half-populated ledger. session_replication_role=replica defers FK/trigger
# checks during the bulk load (the data is already internally consistent).
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 --single-transaction \
  -c "SET session_replication_role = replica;" \
  -f "$IN/public.sql"

echo "==> verify row counts"
psql "$TARGET_DB_URL" -v ON_ERROR_STOP=1 <<'SQL'
  SELECT 'auth.users'  AS tbl, count(*) FROM auth.users
  UNION ALL SELECT 'groups',      count(*) FROM public.groups
  UNION ALL SELECT 'expenses',    count(*) FROM public.expenses
  UNION ALL SELECT 'settlements', count(*) FROM public.settlements;
SQL

echo "Done. Compare these counts against the source before cutting writes over."
