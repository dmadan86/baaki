/**
 * Test stub for `npm:aws4fetch@1`.
 *
 * `_shared/r2.ts` imports `AwsClient` at module load, so importing anything
 * that touches r2.ts (its bucket constants, say) pulls this specifier in.
 * r2-sign's handler takes the R2 client as an injected dependency, so tests
 * never construct or call the real `AwsClient`; this only needs to satisfy the
 * `new AwsClient(...)` / `.sign()` / `.fetch()` shape so the module loads.
 */

export class AwsClient {
  constructor(_options: unknown) {}

  sign(request: Request, _options?: unknown): Promise<Request> {
    return Promise.resolve(request);
  }

  fetch(input: string, _init?: unknown): Promise<Response> {
    return Promise.resolve(new Response(null, { status: 200 }));
  }
}
