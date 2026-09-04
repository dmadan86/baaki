/**
 * storage-sweep — reclaim R2 bytes nothing points at any more (A44).
 *
 * The database cannot delete an R2 object: only an edge function holds an R2
 * credential. So every removal of a `storage_objects` row — an explicit delete,
 * an expired reservation, or a cascade from a deleted profile or group — leaves
 * its key in `storage_orphans`, and this job drains that queue: delete the key
 * from R2, then forget it. It also expires abandoned reservations first, so a
 * single scheduled call keeps both the cap honest and R2 tidy.
 *
 * It is the service role's business and no one else's, so — like the email
 * broadcaster — the gate is a plain comparison against the service key, not a
 * user JWT. Schedule it wherever the R2 secret lives (docs/r2-storage.md); the
 * `waves_storage_expire_pending` cron already keeps the *cap* correct without it,
 * so this lagging or not running costs only reclaimable R2 space, never a wrong
 * ceiling.
 */

import {
  asService,
  serveWithCors,
  errorResponse,
  HttpError,
  json,
  type SupabaseClient,
} from '../_shared/auth.ts';
import { objectUrl, r2, r2Configured, type LogicalBucket } from '../_shared/r2.ts';

/** How many queued keys one invocation reclaims. Well inside an edge wall clock. */
const SWEEP_BATCH = 200;

interface OrphanRow {
  logical_bucket: LogicalBucket;
  path: string;
}

async function sweep(service: SupabaseClient): Promise<{ expired: number; deleted: number }> {
  // Free the cap first: reservations nobody committed become deletable rows,
  // which the trigger has already queued as orphans for the pass below.
  const { data: expired, error: expireError } = await service.rpc('waves_storage_expire_pending');
  if (expireError) throw new HttpError(500, 'INTERNAL', expireError.message);

  const { data, error } = await service.rpc('waves_storage_orphans', { p_limit: SWEEP_BATCH });
  if (error) throw new HttpError(500, 'INTERNAL', error.message);
  const rows = (data ?? []) as OrphanRow[];

  let deleted = 0;
  for (const row of rows) {
    // A DELETE on a key that is already gone is a no-op (R2 answers 2xx/404), so
    // the explicit-delete path having removed it first is harmless. Only clear
    // the queue row once R2 has actually accepted the removal, so a transient R2
    // failure just leaves the key to be retried next run.
    const response = await r2().client.fetch(objectUrl(row.logical_bucket, row.path), {
      method: 'DELETE',
    });
    if (!response.ok && response.status !== 404) continue;

    const { error: clearError } = await service.rpc('waves_storage_orphan_clear', {
      p_logical_bucket: row.logical_bucket,
      p_path: row.path,
    });
    if (!clearError) deleted += 1;
  }

  return { expired: Number(expired ?? 0), deleted };
}

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST to run the sweep');
    }

    const expected = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!expected || request.headers.get('Authorization') !== `Bearer ${expected}`) {
      throw new HttpError(401, 'NOT_AUTHORISED', 'This endpoint is not for clients');
    }

    if (!r2Configured()) {
      throw new HttpError(503, 'R2_NOT_CONFIGURED', 'R2 is not configured on this deployment');
    }

    const service = asService();
    return json(await sweep(service));
  } catch (error) {
    return errorResponse(error, { fn: 'storage-sweep' });
  }
});
