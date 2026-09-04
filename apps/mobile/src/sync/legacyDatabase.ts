/**
 * The mirror's file, carried across the rename.
 *
 * expo-sqlite names the database after the string handed to
 * `openDatabaseAsync`, so renaming the app's database from `baaki.db` to
 * `waves.db` does not open the same file under a new name — it creates an empty
 * one beside it. On a phone that already has the app, that is the entire local
 * ledger and every write still waiting to sync, orphaned in a file nothing
 * opens again.
 *
 * So the file moves first, with its write-ahead log and shared-memory
 * siblings, which SQLite treats as part of the database and will refuse to
 * pair with a differently-named file. A move only happens into an empty slot,
 * which makes it idempotent: the second launch finds `waves.db` already there
 * and does nothing.
 *
 * Every failure is swallowed. A device that cannot move the file gets a fresh,
 * empty mirror and re-syncs from the server, which is a slow start; a device
 * that cannot launch is not a device at all. The rows inside are sealed with a
 * key stored under a name that never changed (`waves.mirror.dek.v1`), so the
 * moved file opens exactly as it did before.
 *
 * The filesystem module is reached for dynamically and allowed to fail — the
 * same rule every native module in here follows, and the reason the driver's
 * own tests can run in plain Node.
 */

const LEGACY_NAME = 'baaki.db';
export const DATABASE_NAME = 'waves.db';

// SQLite's own; `-journal` too, for a database that was last closed without WAL.
const SIDECARS = ['', '-wal', '-shm', '-journal'] as const;

let moved: Promise<void> | null = null;

/** Settles once the pre-rename database file has been moved. Never rejects. */
export function migrateLegacyDatabaseFile(): Promise<void> {
  moved ??= (async () => {
    try {
      const { Directory, File, Paths } = await import('expo-file-system');
      const directory = new Directory(Paths.document, 'SQLite');
      if (!directory.exists) return;
      for (const suffix of SIDECARS) {
        try {
          const previous = new File(directory, `${LEGACY_NAME}${suffix}`);
          const next = new File(directory, `${DATABASE_NAME}${suffix}`);
          if (!previous.exists || next.exists) continue;
          previous.move(next);
        } catch {
          // One sidecar refusing to move must not strand the rest.
        }
      }
    } catch {
      // No filesystem module, no document directory, no move to make.
    }
  })();
  return moved;
}
