/**
 * r2-sign — the only door between the app and Cloudflare R2 (A44).
 *
 * The client never holds an R2 credential: a leaked S3 key is the whole bucket.
 * Instead every read, write and delete is brokered here.
 *
 *   put    → authorise, check the storage ceiling, mint a presigned PUT URL.
 *   commit → after the client's PUT lands, HEAD the object for its true size and
 *            record it in the ledger (the real cap boundary; over-cap or
 *            over-size objects are deleted and refused).
 *   get    → authorise a read, then return an R2 presigned GET for objects the
 *            ledger knows, or a Supabase signed URL for anything still on the
 *            old backend (dual-read; "new uploads only" migration).
 *   delete → authorise, remove from R2, release the ledger row.
 *
 * Authorisation mirrors the Supabase Storage RLS the buckets used to carry:
 * group objects need group membership, a group photo needs the paid gate to
 * write, personal objects need to be the owner's, and an avatar is readable by
 * anyone sharing a group with its owner.
 */

import {
  asCaller,
  asService,
  serveWithCors,
  errorResponse,
  HttpError,
  json,
  requireMembership,
  type SupabaseClient,
} from '../_shared/auth.ts';
import {
  LOGICAL_BUCKETS,
  type LogicalBucket,
  objectUrl,
  r2,
  RESTRICTED_BUCKETS,
  RESTRICTED_URL_TTL_SECONDS,
} from '../_shared/r2.ts';

/** Presigned URLs live an hour, exactly like the Supabase signed URLs they replace. */
const URL_TTL_SECONDS = 60 * 60;

/**
 * A single-object hard ceiling, the R2 equivalent of the old per-bucket
 * `file_size_limit`. Receipts got the largest budget (10 MB); nothing legitimate
 * this app uploads is bigger, so a HEAD past this is a client sending something
 * it should not and the object is dropped rather than stored.
 */
const MAX_OBJECT_BYTES = 12 * 1024 * 1024;

/**
 * The only content types a client may reserve. Every upload the app makes is an
 * image (the shrink pipeline emits webp/jpeg; the picker may hand up png/heic),
 * so this rejects a direct caller trying to park `text/html` or `image/svg+xml`
 * in an image bucket — bytes that, served back under their own content type,
 * would be a stored-XSS vector rather than a receipt. No PDF: nothing in the app
 * uploads one, so allowing it would only widen the surface.
 */
const ALLOWED_CONTENT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

interface Body {
  action?: unknown;
  bucket?: unknown;
  path?: unknown;
  contentType?: unknown;
  contentLength?: unknown;
  groupId?: unknown;
  /**
   * For a restricted bucket, the SUBJECT the object belongs to — a settlement id
   * or an expense id — never a raw object key. The server resolves the key from
   * the party-gated row, so a caller cannot ask for a key it should not have
   * (security review threat (f)).
   */
  subjectId?: unknown;
}

function readBucket(value: unknown): LogicalBucket {
  if (typeof value !== 'string' || !LOGICAL_BUCKETS.includes(value as LogicalBucket)) {
    throw new HttpError(400, 'BAD_BUCKET', 'Unknown storage bucket');
  }
  return value as LogicalBucket;
}

/**
 * A path is opaque to the caller — it never escapes the bucket it names. `..`,
 * a leading slash or an empty segment could address another prefix once joined
 * to the key, so they are refused here, before any signing.
 */
function readPath(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) {
    throw new HttpError(400, 'BAD_PATH', 'Missing object path');
  }
  const segments = value.split('/');
  if (segments.some((s) => s.length === 0 || s === '.' || s === '..')) {
    throw new HttpError(400, 'BAD_PATH', 'Malformed object path');
  }
  return value;
}

/** The group an object belongs to, and whether it is a member-scoped path. */
function locate(
  bucket: LogicalBucket,
  path: string,
): { groupId: string | null; ownerSegment: string | null } {
  const [first, second] = path.split('/');
  switch (bucket) {
    case 'receipts':
      // `<groupId>/<id>` or `personal/<uid>/<id>`.
      return first === 'personal'
        ? { groupId: null, ownerSegment: second ?? null }
        : { groupId: first ?? null, ownerSegment: null };
    case 'group-photos':
    case 'trip-photos':
      // `<groupId>/<id>` — a group object. Membership (no paid gate for the
      // album) is enforced by the generic group branch in authorize*.
      return { groupId: first ?? null, ownerSegment: null };
    case 'captures':
    case 'avatars':
      // `<ownerId>/…` — owner is the first segment for both.
      return { groupId: null, ownerSegment: first ?? null };
    case 'settlement-proofs':
    case 'expense-attachments':
      // Restricted buckets are never authorised by path — the caller names a
      // subject id and the server resolves the key from the party-gated row.
      // These cases exist only so the switch stays exhaustive.
      return { groupId: null, ownerSegment: null };
  }
}

/** The group a restricted subject (settlement / expense) belongs to. */
async function groupOfSubject(
  service: SupabaseClient,
  bucket: LogicalBucket,
  subjectId: string,
): Promise<string> {
  const table = bucket === 'settlement-proofs' ? 'settlements' : 'expenses';
  const { data, error } = await service
    .from(table)
    .select('group_id')
    .eq('id', subjectId)
    .maybeSingle();
  if (error) throw new HttpError(500, 'INTERNAL', error.message);
  if (!data) throw new HttpError(404, 'NOT_FOUND', 'No such subject');
  return (data as { group_id: string }).group_id;
}

/** The caller must be a party to the subject — repeated here even though the DB
 *  RLS enforces it, so the byte door and the row door are both party-gated. */
async function requireRestrictedParty(
  caller: SupabaseClient,
  bucket: LogicalBucket,
  subjectId: string,
): Promise<void> {
  const rpc =
    bucket === 'settlement-proofs' ? 'baaki_is_settlement_party' : 'baaki_is_expense_party';
  const arg =
    bucket === 'settlement-proofs' ? { p_settlement_id: subjectId } : { p_expense_id: subjectId };
  const { data, error } = await caller.rpc(rpc, arg);
  if (error) throw new HttpError(500, 'INTERNAL', error.message);
  if (data !== true) throw new HttpError(403, 'NOT_A_PARTY', 'Not a party to this');
}

/**
 * Verify — AS THE CALLER, so party RLS applies — that a party-visible row exists
 * for this (subject, path). The caller names both because an expense may carry
 * several attachments; a non-party sees no matching row and is refused. This is
 * forgery-proof (threat (f)): a crafted path that no party-visible row references
 * matches nothing, and a non-party sees no rows at all.
 */
async function assertRestrictedPath(
  caller: SupabaseClient,
  bucket: LogicalBucket,
  subjectId: string,
  path: string,
): Promise<void> {
  const table = bucket === 'settlement-proofs' ? 'settlement_proofs' : 'expense_attachments';
  const subjectCol = bucket === 'settlement-proofs' ? 'settlement_id' : 'expense_id';
  const { data, error } = await caller
    .from(table)
    .select('id')
    .eq(subjectCol, subjectId)
    .eq('storage_path', path)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw new HttpError(500, 'INTERNAL', error.message);
  if (!data) throw new HttpError(403, 'NOT_VISIBLE', 'Not visible to you');
}

function readSubject(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new HttpError(400, 'BAD_SUBJECT', 'Missing subject id');
  }
  return value;
}

async function callerUserId(caller: SupabaseClient): Promise<string> {
  const { data, error } = await caller.auth.getUser();
  if (error || !data?.user) throw new HttpError(401, 'NOT_AUTHENTICATED', 'Sign in first');
  return data.user.id;
}

/** True when the two profiles share at least one live group. */
async function sharesGroup(service: SupabaseClient, a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const { data, error } = await service.rpc('baaki_profiles_share_group', { p_a: a, p_b: b });
  if (error) throw new HttpError(500, 'INTERNAL', error.message);
  return data === true;
}

/**
 * Authorise a write, and return the group the bytes are charged to. Mirrors the
 * old storage INSERT policies: group membership for group objects (plus the
 * paid gate for a group photo), ownership for personal ones.
 */
async function authorizeWrite(
  caller: SupabaseClient,
  service: SupabaseClient,
  uid: string,
  bucket: LogicalBucket,
  path: string,
  subjectId: string | null,
): Promise<{ groupId: string | null }> {
  // A restricted object is authorised by its subject, not its path: the caller
  // must be a live member of the subject's group AND a party to it. Membership
  // alone is insufficient — that is the whole point of the tier.
  if (RESTRICTED_BUCKETS.has(bucket)) {
    if (!subjectId) throw new HttpError(400, 'BAD_SUBJECT', 'A restricted write needs a subject');
    // The object key MUST be scoped to its subject: `<subjectId>/…`. Without this
    // a party to one subject could name a path under another's prefix and
    // overwrite or delete that object — the byte-door twin of the DB's own
    // `storage_path LIKE '<subjectId>/%'` check. One canonical contract, enforced
    // at both doors.
    if (path.split('/')[0] !== subjectId) {
      throw new HttpError(400, 'BAD_PATH', 'The key must be scoped to its subject');
    }
    const groupId = await groupOfSubject(service, bucket, subjectId);
    await requireMembership(caller, groupId);
    await requireRestrictedParty(caller, bucket, subjectId);
    return { groupId };
  }

  const { groupId, ownerSegment } = locate(bucket, path);

  if (bucket === 'group-photos') {
    if (!groupId) throw new HttpError(400, 'BAD_PATH', 'A group photo needs a group');
    await requireMembership(caller, groupId);
    const { data: allowed, error } = await caller.rpc('baaki_can_upload_group_photo', {
      p_group_id: groupId,
    });
    if (error) throw new HttpError(500, 'INTERNAL', error.message);
    if (allowed !== true) {
      throw new HttpError(403, 'PHOTO_LOCKED', 'A group photo is a paid feature');
    }
    return { groupId };
  }

  if (groupId) {
    // A group receipt: membership is enough to write it.
    await requireMembership(caller, groupId);
    return { groupId };
  }

  // Personal object (avatar, capture, personal receipt): the owner segment must
  // be the caller's own id.
  if (ownerSegment !== uid) {
    throw new HttpError(403, 'NOT_OWNER', 'You can only write your own files');
  }

  // A personal receipt backup (`receipts/personal/<uid>/…`) is a paid feature —
  // the Supabase insert policy gated it, so the R2 path must too.
  if (bucket === 'receipts') {
    const { data: allowed, error } = await caller.rpc('baaki_can_upload_group_photo', {
      p_group_id: null,
    });
    if (error) throw new HttpError(500, 'INTERNAL', error.message);
    if (allowed !== true) {
      throw new HttpError(403, 'STORAGE_PAID_ONLY', 'Storing receipts on Waves is a paid feature');
    }
  }
  return { groupId: null };
}

/** Authorise a read. Group objects need membership; avatars need a shared group. */
async function authorizeRead(
  caller: SupabaseClient,
  service: SupabaseClient,
  uid: string,
  bucket: LogicalBucket,
  path: string,
): Promise<void> {
  const { groupId, ownerSegment } = locate(bucket, path);

  if (groupId) {
    await requireMembership(caller, groupId);
    return;
  }
  if (bucket === 'avatars') {
    if (!ownerSegment || !(await sharesGroup(service, uid, ownerSegment))) {
      throw new HttpError(403, 'NOT_VISIBLE', 'That avatar is not visible to you');
    }
    return;
  }
  // Personal receipt / capture: owner only.
  if (ownerSegment !== uid) {
    throw new HttpError(403, 'NOT_OWNER', 'You can only read your own files');
  }
}

serveWithCors(async (request) => {
  try {
    if (request.method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'POST only');
    }
    const caller = asCaller(request);
    const service = asService();
    const uid = await callerUserId(caller);

    const body = (await request.json().catch(() => ({}))) as Body;
    const action = body.action;
    const bucket = readBucket(body.bucket);
    const restricted = RESTRICTED_BUCKETS.has(bucket);
    const subjectId = restricted ? readSubject(body.subjectId) : null;
    const path = readPath(body.path);

    // A restricted read is authorised by (SUBJECT, path): the server confirms a
    // party-visible row references that path before signing it, so a non-party
    // (who sees no row) is refused and a crafted path matches nothing (threat
    // (f)). Short TTL, and no Supabase-Storage dual-read fallback — these buckets
    // are new, so a missing object is simply gone, not "on the old backend".
    if (action === 'get' && restricted) {
      await assertRestrictedPath(caller, bucket, subjectId as string, path);
      const getUrl = new URL(objectUrl(bucket, path));
      getUrl.searchParams.set('X-Amz-Expires', String(RESTRICTED_URL_TTL_SECONDS));
      const signed = await r2().client.sign(new Request(getUrl), { aws: { signQuery: true } });
      return json({ url: signed.url });
    }

    // ── mint a presigned PUT ──────────────────────────────────────────────
    if (action === 'put') {
      const { groupId } = await authorizeWrite(caller, service, uid, bucket, path, subjectId);

      const declared = Number(body.contentLength);
      if (!Number.isFinite(declared) || declared <= 0) {
        throw new HttpError(400, 'BAD_LENGTH', 'contentLength is required');
      }
      if (declared > MAX_OBJECT_BYTES) {
        throw new HttpError(413, 'TOO_LARGE', 'That image is too large');
      }

      const contentType = typeof body.contentType === 'string' ? body.contentType : 'image/webp';
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new HttpError(415, 'BAD_CONTENT_TYPE', 'Only image uploads are allowed');
      }

      // Reserve the space *now*, before the URL exists — a presign the client
      // never commits still holds cap until it is swept, which is what stops
      // "presign forever, commit never" from filling R2 for free. Charges the
      // client's declared length; `commit` corrects it to the true size.
      const { error } = await service.rpc('baaki_storage_reserve', {
        p_profile_id: uid,
        p_group_id: groupId,
        p_logical_bucket: bucket,
        p_path: path,
        p_bytes: declared,
        p_content_type: contentType,
      });
      if (error) {
        const message = error.message ?? '';
        if (message.includes('STORAGE_CAP')) {
          throw new HttpError(
            402,
            'STORAGE_CAP',
            'You have reached your free storage limit; upgrade to add more.',
          );
        }
        if (message.includes('STORAGE_TOO_MANY_PENDING')) {
          throw new HttpError(
            429,
            'TOO_MANY_PENDING',
            'Too many uploads in flight; finish one and try again.',
          );
        }
        throw new HttpError(500, 'INTERNAL', message);
      }

      const putUrl = new URL(objectUrl(bucket, path));
      putUrl.searchParams.set('X-Amz-Expires', String(URL_TTL_SECONDS));
      const signed = await r2().client.sign(new Request(putUrl, { method: 'PUT' }), {
        aws: { signQuery: true, allHeaders: true },
        headers: { 'content-type': contentType },
      });
      return json({ url: signed.url, method: 'PUT', headers: { 'content-type': contentType } });
    }

    // ── record the object once the PUT has landed ─────────────────────────
    if (action === 'commit') {
      const { groupId } = await authorizeWrite(caller, service, uid, bucket, path, subjectId);
      const contentType = typeof body.contentType === 'string' ? body.contentType : 'image/webp';
      if (!ALLOWED_CONTENT_TYPES.has(contentType)) {
        throw new HttpError(415, 'BAD_CONTENT_TYPE', 'Only image uploads are allowed');
      }

      const head = await r2().client.fetch(objectUrl(bucket, path), { method: 'HEAD' });
      if (!head.ok) throw new HttpError(404, 'NOT_UPLOADED', 'Object was not uploaded');
      const size = Number(head.headers.get('content-length') ?? '0');
      if (size > MAX_OBJECT_BYTES) {
        await r2().client.fetch(objectUrl(bucket, path), { method: 'DELETE' });
        throw new HttpError(413, 'TOO_LARGE', 'That image is too large');
      }

      const { error } = await service.rpc('baaki_storage_record', {
        p_profile_id: uid,
        p_group_id: groupId,
        p_logical_bucket: bucket,
        p_path: path,
        p_bytes: size,
        p_content_type: contentType,
      });
      if (error) {
        // The cap boundary — the reservation trusted a declared size, the object
        // landed larger. Release the reservation this upload holds and, only when
        // that actually removed a pending row (a brand-new upload, not a
        // replacement of an existing committed image), delete the object we just
        // wrote. A refused *replacement* leaves the committed row and its image
        // untouched — never destroy the good copy that is already there.
        let removedReservation = false;
        try {
          const { data } = await service.rpc('baaki_storage_release_reservation', {
            p_logical_bucket: bucket,
            p_path: path,
          });
          removedReservation = data === true;
        } catch {
          // Best-effort — a stale pending row is swept by the expiry job anyway.
        }
        if (removedReservation) {
          await r2().client.fetch(objectUrl(bucket, path), { method: 'DELETE' });
        }
        if (error.message.includes('STORAGE_CAP')) {
          throw new HttpError(
            402,
            'STORAGE_CAP',
            'You have reached your free storage limit; upgrade to add more.',
          );
        }
        throw new HttpError(500, 'INTERNAL', error.message);
      }
      return json({ ok: true, bytes: size });
    }

    // ── resolve a readable URL (R2 if we own it, else the old backend) ─────
    if (action === 'get') {
      await authorizeRead(caller, service, uid, bucket, path);

      const { data: known, error: lookupError } = await service
        .from('storage_objects')
        .select('path')
        .eq('logical_bucket', bucket)
        .eq('path', path)
        .maybeSingle();
      if (lookupError) throw new HttpError(500, 'INTERNAL', lookupError.message);

      if (known) {
        const getUrl = new URL(objectUrl(bucket, path));
        getUrl.searchParams.set('X-Amz-Expires', String(URL_TTL_SECONDS));
        const signed = await r2().client.sign(new Request(getUrl), {
          aws: { signQuery: true },
        });
        return json({ url: signed.url });
      }

      // Not in R2 → still on Supabase Storage. Mint its signed URL with the
      // service role, so the same edge call resolves either backend.
      const { data, error } = await service.storage
        .from(bucket)
        .createSignedUrl(path, URL_TTL_SECONDS);
      if (error || !data?.signedUrl) throw new HttpError(404, 'NOT_FOUND', 'No such object');
      return json({ url: data.signedUrl });
    }

    // ── release a failed upload's reservation ─────────────────────────────
    // The client calls this when its PUT to R2 did not land. It is the safe
    // counterpart to `delete`: it removes the row only while it is still a
    // pending reservation, and deletes the R2 object only if that reservation
    // was actually removed — so a failed *replacement*, which never held a
    // pending row, cannot take the committed image down with it.
    if (action === 'release') {
      await authorizeWrite(caller, service, uid, bucket, path, subjectId);
      const { data: removed, error } = await service.rpc('baaki_storage_release_reservation', {
        p_logical_bucket: bucket,
        p_path: path,
      });
      if (error) throw new HttpError(500, 'INTERNAL', error.message);
      if (removed === true) {
        await r2().client.fetch(objectUrl(bucket, path), { method: 'DELETE' });
      }
      return json({ ok: true });
    }

    // ── delete an object and forget it ────────────────────────────────────
    if (action === 'delete') {
      await authorizeWrite(caller, service, uid, bucket, path, subjectId);
      // authorizeWrite proves party + subject-scoped path, but not that this
      // exact object is a live attachment/proof the caller may take down. For a
      // restricted bucket, require a live row that references this path (the same
      // check a `get` makes): otherwise any party to the subject could delete a
      // co-party's bytes out of band — the row and audit trail left pointing at
      // nothing — bypassing the author/admin-only delete matrix in the DB RPCs.
      if (restricted) {
        await assertRestrictedPath(caller, bucket, subjectId as string, path);
      }
      await r2().client.fetch(objectUrl(bucket, path), { method: 'DELETE' });
      // A legacy object may still live on Supabase Storage (dual-read); remove it
      // there too, or the fallback read would keep serving a deleted image.
      await service.storage
        .from(bucket)
        .remove([path])
        .catch(() => {});
      const { error } = await service.rpc('baaki_storage_release', {
        p_logical_bucket: bucket,
        p_path: path,
      });
      if (error) throw new HttpError(500, 'INTERNAL', error.message);
      return json({ ok: true });
    }

    throw new HttpError(400, 'BAD_ACTION', 'Unknown action');
  } catch (error) {
    return errorResponse(error, { fn: 'r2-sign' });
  }
});
