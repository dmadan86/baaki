#!/usr/bin/env bash
# Dump a Supabase (or any Postgres) project into portable .sql files.
#
# Produces three files in ./out so you can restore selectively:
#   roles.sql   — the auth users' owning grants (kept minimal)
#   auth.sql    — the `auth` schema: users + identities (PRESERVES UUIDs, which
#                 are referenced as profile_id everywhere — do NOT regenerate)
#   public.sql  — the app data (groups, expenses, ledger, ...)
#
# `public` structure is owned by Prisma; on restore you run migrations first
# then load public.sql as DATA ONLY. See MIGRATION.md.
#
# Usage:
#   export SOURCE_DB_URL="postgres://postgres:PASSWORD@db.<ref>.supabase.co:5432/postgres"
#   ./dump-from-supabase.sh
#
# SOURCE_DB_URL = the project's DIRECT connection (Project Settings > Database >
# Connection string > URI, session mode / port 5432). Not the pooler.
set -euo pipefail

: "${SOURCE_DB_URL:?export SOURCE_DB_URL=the Supabase DIRECT connection URI}"
OUT="${OUT_DIR:-./out}"
mkdir -p "$OUT"

echo "==> auth schema (users + identities, UUIDs preserved)"
pg_dump "$SOURCE_DB_URL" \
  --schema=auth \
  --no-owner --no-privileges --disable-triggers \
  --data-only \
  --table='auth.users' --table='auth.identities' \
  > "$OUT/auth.sql"

echo "==> public schema — DATA ONLY (structure comes from Prisma migrations)"
pg_dump "$SOURCE_DB_URL" \
  --schema=public \
  --no-owner --no-privileges --disable-triggers \
  --data-only \
  --exclude-table-data='public._prisma_migrations' \
  > "$OUT/public.sql"

echo "==> public schema — STRUCTURE snapshot (reference / diff only, not restored)"
pg_dump "$SOURCE_DB_URL" \
  --schema=public --schema-only --no-owner --no-privileges \
  > "$OUT/public.schema.sql"

echo "Done. Files in $OUT/ :"
ls -lh "$OUT"
echo
echo "NEXT: bring up the self-host stack, run Prisma migrations against it,"
echo "then ./restore-to-selfhost.sh . See MIGRATION.md."
