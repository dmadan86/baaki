/**
 * invite-mint entrypoint — the thin `Deno.serve` shell.
 *
 * The request handling is a pure function in `handler.ts` taking its boundaries
 * (the Supabase clients, the membership check, the rate limiter) as injected
 * dependencies, so it can be unit-tested without Deno or a network (see
 * `handler.test.ts`). This file wires the real implementations in.
 */

import { asCaller, asService, requireMembership, serveWithCors } from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';
import { handleInviteMint } from './handler.ts';

serveWithCors((request) =>
  handleInviteMint(request, { asCaller, asService, requireMembership, enforceRateLimit }),
);
