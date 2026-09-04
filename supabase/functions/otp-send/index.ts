/**
 * otp-send entrypoint — the thin `Deno.serve` shell.
 *
 * All the request handling lives in `handler.ts` as a pure function over
 * injected boundaries, so it can be unit-tested without Deno, a database or a
 * Twilio account (see `handler.test.ts`). This file only wires the real ones in.
 *
 * `serveWithCors` is deliberately not used: the caller is GoTrue talking
 * server-to-server, never a browser, so there is no preflight to answer and no
 * origin to echo.
 */

import { asService } from '../_shared/auth.ts';
import { handleOtpSend } from './handler.ts';

Deno.serve((request) =>
  handleOtpSend(request, {
    service: asService,
    fetchImpl: fetch,
    env: (key) => Deno.env.get(key),
  }),
);
