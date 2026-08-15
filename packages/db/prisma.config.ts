/**
 * Prisma CLI configuration (Prisma 7).
 *
 * Prisma 7 removed `url`/`directUrl` from the datasource block in the schema —
 * connection URLs live here instead (see https://pris.ly/d/config-datasource).
 * The CLI (migrate, diff) connects through `datasource.url`; there is no longer
 * a separate pooled-vs-direct split, so this points at the *direct* connection
 * (`DIRECT_URL`) — migrations run DDL and must not go through pgbouncer. The
 * runtime pooled URL (`DATABASE_URL`) is a client-constructor concern, and the
 * mobile app never instantiates the client (TDR §2.0); server code passes its
 * own adapter.
 *
 * Prisma 7's config is not auto-loaded from `.env`, so load it explicitly.
 */
import 'dotenv/config';
import { defineConfig, env } from 'prisma/config';

type Env = {
  DIRECT_URL: string;
};

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: env<Env>('DIRECT_URL'),
  },
});
