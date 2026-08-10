/**
 * account-delete — the half of erasure a database role cannot do (A22).
 *
 * `baaki_delete_my_account` erases the person from the ledger: every membership
 * becomes an unnamed ghost, and the profile row goes with everything personal
 * hanging off it (push tokens, subscriptions, notifications, usage). What it
 * cannot touch is the auth identity — `auth.users` lives in a schema the
 * database role does not own, and removing a row there needs the admin API,
 * which needs the service key, which only an edge function holds. Until this
 * function existed the RPC ran and the sign-in survived it: a deleted account
 * you could still log into, reaching nothing. This closes that.
 *
 * Order is the whole design. The data is erased first, as the caller, so RLS
 * and `baaki_current_profile_id()` decide whose account this is by the same JWT
 * the app is subject to. Only then is the identity deleted, as the service.
 * A run that stops in the middle has erased the data and left an identity that
 * signs in to nothing — recoverable, because the RPC is idempotent (it reads
 * the caller's id from the JWT, not from a row, so a second run over an
 * already-erased profile updates nothing and deletes nothing and returns ok)
 * and the client can simply call again. The reverse order could not be
 * recovered: an identity gone before the data would strand the ledger rows with
 * no signed-in caller able to reach them.
 */

import {
  asCaller,
  asService,
  CORS_HEADERS,
  errorResponse,
  HttpError,
  json,
} from '../_shared/auth.ts';
import { enforceRateLimit } from '../_shared/rateLimit.ts';

interface DeleteRequest {
  /** Parting words, kept after the account is gone (feedback FK is SET NULL). */
  reason?: string | null;
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: CORS_HEADERS });

  try {
    if (request.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Use POST');

    const caller = asCaller(request);
    const service = asService();

    const { data: user, error: userError } = await caller.auth.getUser();
    if (userError || !user?.user) {
      throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in first');
    }
    const userId = user.user.id;

    // Deletion is rare and idempotent, so the cap is not really about the ledger
    // — it is a fuse on the admin API. A stuck client that keeps re-firing the
    // recovery retry should slow down rather than hammer `deleteUser` all hour.
    await enforceRateLimit(service, request, 'account-delete', userId);

    // Body is optional: someone can leave without saying why.
    let reason: string | null = null;
    try {
      const body = (await request.json()) as DeleteRequest;
      const trimmed = (body?.reason ?? '').trim();
      reason = trimmed.length > 0 ? trimmed : null;
    } catch {
      // No body, or not JSON. Treated as "no reason given", which is fine.
    }

    // Step one: erase the data, as the caller. SECURITY DEFINER inside, but it
    // reads the subject from this JWT, so it can only ever erase the caller.
    const { data: erased, error: eraseError } = await caller.rpc('baaki_delete_my_account', {
      p_feedback: reason,
    });
    if (eraseError) {
      // NOT_SIGNED_IN here would mean the JWT carried no subject — a 401, not a
      // 500. Everything else is a genuine failure of the erasure itself.
      if (/NOT_SIGNED_IN/.test(eraseError.message)) {
        throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in first');
      }
      throw new HttpError(500, 'ERASE_FAILED', eraseError.message);
    }

    // Step two: remove the auth identity, as the service. If this fails the data
    // is already gone; the account can still sign in, so the client is told the
    // erasure did not fully complete and can retry — the RPC above will no-op
    // the second time and this line will run again.
    const { error: identityError } = await service.auth.admin.deleteUser(userId);
    if (identityError) {
      console.error('identity delete failed after data erasure:', identityError.message);
      throw new HttpError(
        500,
        'IDENTITY_DELETE_FAILED',
        'Your data was erased, but the sign-in could not be removed. Please try again.',
      );
    }

    const result = (erased ?? {}) as { memberships_anonymised?: number };
    return json({
      ok: true,
      memberships_anonymised: result.memberships_anonymised ?? 0,
      identity_deleted: true,
    });
  } catch (error) {
    return errorResponse(error, { fn: 'account-delete' });
  }
});
