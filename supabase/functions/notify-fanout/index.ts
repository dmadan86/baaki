/**
 * notify-fanout entrypoint — the thin `Deno.serve` shell.
 *
 * The push half is a pure function in `handler.ts` taking its boundaries (the
 * service client, an env reader, `fetch`, and the email half) as injected
 * dependencies, so it can be unit-tested without Deno or a network (see
 * `handler.test.ts`). This file wires the real implementations in.
 */

import { asService, serveWithCors } from '../_shared/auth.ts';
import { dispatchEmail, handlePushFanout } from './handler.ts';

serveWithCors((request) =>
  handlePushFanout(request, {
    asService,
    env: (name) => Deno.env.get(name),
    fetchImpl: fetch,
    dispatchEmail,
  }),
);
