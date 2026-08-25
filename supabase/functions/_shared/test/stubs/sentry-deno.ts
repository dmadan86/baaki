/**
 * Test stub for `npm:@sentry/deno@10`.
 *
 * `_shared/observability.ts` is dynamically imported by `errorResponse` on the
 * 500 path and imports the Sentry SDK at module load. With no `SENTRY_DSN` in
 * the environment (the test default) reporting is inert, so these no-ops are
 * exactly what the real module would do — they just let the import resolve.
 */

export function init(_options: unknown): void {}

export function captureException(_error: unknown, _hint?: unknown): void {}

export function flush(_timeout?: number): Promise<boolean> {
  return Promise.resolve(true);
}
