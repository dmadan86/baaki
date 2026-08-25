/**
 * Vitest setup for the Supabase edge functions.
 *
 * The functions run on Deno: they read configuration through `Deno.env` and
 * register their HTTP entrypoint with `Deno.serve`. Node has neither global, so
 * this file installs the smallest shim that lets the modules load and be tested
 * without a Deno runtime:
 *
 *   • `Deno.env.get` reads through to `process.env`, so a test can set an env
 *     var with `process.env.X = ...` (or vitest's `vi.stubEnv`) and the module
 *     under test sees it.
 *   • `Deno.serve` records the handler it is given on `globalThis` instead of
 *     opening a socket, so a test can grab the registered handler and invoke it
 *     directly (see the `serveWithCors` tests).
 *
 * The `npm:` specifiers the functions import (`@supabase/supabase-js`,
 * `aws4fetch`, `@sentry/deno`) and the built `_shared/core.js` bundle are
 * redirected to stubs / source in `vitest.config.ts`.
 */

export interface DenoServeHandler {
  (request: Request): Response | Promise<Response>;
}

interface DenoShim {
  env: {
    get(name: string): string | undefined;
    set(name: string, value: string): void;
    delete(name: string): void;
    toObject(): Record<string, string>;
  };
  serve(handler: DenoServeHandler): { finished: Promise<void>; shutdown(): void };
}

const globalWithDeno = globalThis as typeof globalThis & {
  Deno?: DenoShim;
  __lastServeHandler?: DenoServeHandler;
};

globalWithDeno.Deno = {
  env: {
    get: (name: string) => process.env[name],
    set: (name: string, value: string) => {
      process.env[name] = value;
    },
    delete: (name: string) => {
      delete process.env[name];
    },
    toObject: () => ({ ...process.env }) as Record<string, string>,
  },
  serve: (handler: DenoServeHandler) => {
    globalWithDeno.__lastServeHandler = handler;
    return { finished: Promise.resolve(), shutdown: () => {} };
  },
};

/** The handler most recently registered with the `Deno.serve` shim. */
export function lastServeHandler(): DenoServeHandler {
  const handler = globalWithDeno.__lastServeHandler;
  if (!handler) throw new Error('Deno.serve was never called');
  return handler;
}
