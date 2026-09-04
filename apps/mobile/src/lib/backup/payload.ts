/**
 * What a personal-ledger backup actually *is*, and how a restore folds one back
 * in. Pure — no keystore, no network, no React — so every decision in here is
 * unit-testable, and the parts that are not pure (the key, the upload) have
 * nothing left in them worth arguing about.
 *
 * The backed-up thing is the raw `personal_records` rows for the signed-in
 * owner, exactly as the mirror materialises them (server rows plus the offline
 * queue replayed on top, per ADR-005). Not the decoded `PersonalTxn`/`Loan`
 * shapes the screens use: those are one lossy interpretation of the blob, and a
 * backup that only understands today's fields cannot restore tomorrow's. The
 * `data` blob is opaque here for the same reason it is opaque to the server.
 *
 * A restore is deliberately additive. Every record carries a client-chosen id
 * that is already the idempotency key for `personal.upsert`, so a record the
 * device already has is skipped and a record it is missing is re-queued — no
 * merge, no field-level resolution, no clobbering something newer with an older
 * copy. That makes the two cases people actually hit correct: a fresh install
 * (nothing local, everything comes back) and a partial loss (only the missing
 * rows return). It also means a restore can be run twice with no second effect.
 *
 * Tombstones ride along but are never re-applied. A backup that could delete
 * records on restore is a backup that can lose data, and the whole point of the
 * file is that it cannot.
 */

/** Marks a file as ours before anything is decrypted. */
export const BACKUP_FORMAT = 'waves.personal.backup';
/** The envelope version. Bumped only when the *outer* shape changes. */
export const BACKUP_VERSION = 1;
/** The AEAD the body is sealed with — see `recoveryKey.ts`. */
export const BACKUP_ALG = 'xchacha20poly1305';

/** One personal-finance record, as stored. `data` is opaque on purpose. */
export interface BackupRecord {
  readonly id: string;
  readonly kind: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

/** The part that is encrypted: everything that says anything about anybody. */
export interface BackupBody {
  readonly ownerId: string;
  readonly createdAt: string;
  readonly records: readonly BackupRecord[];
}

/**
 * The part Google can read. Deliberately almost nothing: enough to recognise
 * the file and pick the right opener, and not one field more. The record count
 * and the dates of somebody's spending live inside the sealed body — "how many
 * transactions does this person have" is not a question a backup should answer
 * to whoever holds the drive.
 */
export interface BackupFile {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: number;
  readonly alg: string;
  /** When the backup was taken. Drive knows the file's mtime anyway. */
  readonly createdAt: string;
  /** The sealed body, in the `v1:`-tagged form `rowCipher.seal` produces. */
  readonly sealed: string;
}

/** A file that is not ours, or is from a future version we cannot read. */
export class BackupFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupFormatError';
  }
}

/** The wrong key, a corrupted file, or a file belonging to another account. */
export class BackupOpenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BackupOpenError';
  }
}

/**
 * The associated data the body is sealed against: the format, the version and
 * the owner. It is authenticated, not encrypted, so it costs nothing to carry —
 * and it means a sealed body lifted out of one account's file and dropped into
 * another's fails to open rather than silently restoring one person's ledger
 * into someone else's.
 */
export function backupAad(ownerId: string): string {
  return `${BACKUP_FORMAT}:v${BACKUP_VERSION}:${ownerId}`;
}

/** The rows to back up, narrowed to what the envelope keeps. */
export interface SourceRecord {
  readonly id: string;
  readonly record_kind: string;
  readonly data: Record<string, unknown>;
  readonly created_at: string;
  readonly deleted_at: string | null;
}

/** Build the body for `ownerId` from the mirror's rows, in a stable order. */
export function buildBody(
  ownerId: string,
  records: readonly SourceRecord[],
  now: Date,
): BackupBody {
  return {
    ownerId,
    createdAt: now.toISOString(),
    // Sorted by id so two backups of an unchanged ledger produce byte-identical
    // bodies. Not an optimisation the uploader uses today, but it makes the
    // file diffable and the tests independent of mirror ordering.
    records: [...records]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((row) => ({
        id: row.id,
        kind: row.record_kind,
        data: row.data,
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
      })),
  };
}

/** Wrap a sealed body in the envelope that goes to the cloud. */
export function buildFile(sealed: string, createdAt: string): BackupFile {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    alg: BACKUP_ALG,
    createdAt,
    sealed,
  };
}

/** Read an envelope back, or say which way it is wrong. */
export function parseFile(text: string): BackupFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new BackupFormatError('backup file is not JSON');
  }
  const file = raw as Partial<BackupFile>;
  if (file?.format !== BACKUP_FORMAT) throw new BackupFormatError('not a Waves backup');
  // A newer app may write a version this build cannot read. Refusing is the
  // honest answer; guessing at an unknown shape is how a restore loses rows.
  if (typeof file.version !== 'number' || file.version > BACKUP_VERSION) {
    throw new BackupFormatError(`backup version ${String(file.version)} is newer than this app`);
  }
  if (file.alg !== BACKUP_ALG) throw new BackupFormatError(`unknown algorithm ${String(file.alg)}`);
  if (typeof file.sealed !== 'string' || file.sealed.length === 0) {
    throw new BackupFormatError('backup file has no body');
  }
  return {
    format: BACKUP_FORMAT,
    version: file.version,
    alg: file.alg,
    createdAt: typeof file.createdAt === 'string' ? file.createdAt : '',
    sealed: file.sealed,
  };
}

/**
 * Read an opened (decrypted) body. Defensive in the same spirit as the record
 * decoders in core: a row missing its id or kind is dropped rather than allowed
 * to become an upsert with an empty key.
 */
export function parseBody(plain: string, expectOwnerId: string): BackupBody {
  let raw: unknown;
  try {
    raw = JSON.parse(plain);
  } catch {
    throw new BackupOpenError('backup body is not JSON');
  }
  const body = raw as Partial<BackupBody>;
  if (typeof body?.ownerId !== 'string' || body.ownerId.length === 0) {
    throw new BackupOpenError('backup body has no owner');
  }
  // The AEAD already binds the body to the owner, so this can only fail on a
  // file we sealed ourselves — but a mismatch here would restore one account's
  // records under another's id, so it is checked rather than assumed.
  if (body.ownerId !== expectOwnerId) {
    throw new BackupOpenError('backup belongs to a different account');
  }
  const records = Array.isArray(body.records) ? body.records : [];
  return {
    ownerId: body.ownerId,
    createdAt: typeof body.createdAt === 'string' ? body.createdAt : '',
    records: records.filter(
      (record): record is BackupRecord =>
        typeof record?.id === 'string' &&
        record.id.length > 0 &&
        typeof record.kind === 'string' &&
        record.kind.length > 0 &&
        typeof record.data === 'object' &&
        record.data !== null,
    ),
  };
}

export interface RestorePlan {
  /** The records to re-queue as upserts, in the order they should be sent. */
  readonly restore: readonly BackupRecord[];
  /** How many were already on this device — reported, not acted on. */
  readonly alreadyHere: number;
  /** How many were tombstones in the backup and deliberately left alone. */
  readonly deleted: number;
}

/**
 * Decide what a restore should actually write. `localIds` is every personal
 * record id the device already knows about, deleted ones included: a record
 * this device has already deleted must not come back, or "restore" would undo
 * a deletion the person made on purpose.
 */
export function planRestore(
  localIds: ReadonlySet<string>,
  body: Pick<BackupBody, 'records'>,
): RestorePlan {
  const restore: BackupRecord[] = [];
  let alreadyHere = 0;
  let deleted = 0;
  for (const record of body.records) {
    if (record.deletedAt !== null && record.deletedAt !== undefined) {
      deleted += 1;
      continue;
    }
    if (localIds.has(record.id)) {
      alreadyHere += 1;
      continue;
    }
    restore.push(record);
  }
  return { restore, alreadyHere, deleted };
}
