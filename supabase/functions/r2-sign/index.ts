/**
 * r2-sign entrypoint — the thin `Deno.serve` shell.
 *
 * All the request handling lives in `handler.ts` as a pure function taking its
 * side-effecting boundaries as injected dependencies, so it can be unit-tested
 * without Deno or a real bucket (see `handler.test.ts`). This file only wires
 * the real Supabase clients, the real R2 client and the real object-URL builder
 * into it.
 */

import { asCaller, asService, serveWithCors } from '../_shared/auth.ts';
import { objectUrl, r2 } from '../_shared/r2.ts';
import { handleR2Sign } from './handler.ts';

serveWithCors((request) => handleR2Sign(request, { asCaller, asService, r2, objectUrl }));
