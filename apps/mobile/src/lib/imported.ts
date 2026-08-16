/**
 * What this phone has already imported.
 *
 * This is not the thing that stops a duplicate — `expenses.client_mutation_id`
 * is UNIQUE and the ids are derived from the imported row itself (lib/importId),
 * so a re-import is refused by the database whatever any client believes. This
 * list exists so the refusal is *visible*: without it, pasting last week's
 * messages again would show them all as new, the person would confirm them,
 * and nothing would appear. Silently doing nothing is the worst of the three
 * possible behaviours.
 *
 * It rides on the draft store the sync engine already keeps, so it survives a
 * restart. It is per-device on purpose — a second phone re-proposing an
 * expense is a mild annoyance, and the unique constraint still holds the line.
 */

import { useCallback, useEffect, useState } from 'react';

import { syncEngine } from '@/sync/engine';

const keyFor = (groupId: string): string => `import:seen:${groupId}`;

/** Grows without bound otherwise; a trip's worth of keys is what is useful. */
const KEEP = 500;

export interface ImportedKeys {
  /** Dedupe keys already imported into this group, for `proposeFromSms`. */
  keys: ReadonlySet<string>;
  remember: (keys: readonly string[]) => Promise<void>;
}

export function useImported(groupId: string): ImportedKeys {
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let active = true;
    void syncEngine.readDraft<string[]>(keyFor(groupId)).then((stored) => {
      if (active && stored) setKeys(new Set(stored));
    });
    return () => {
      active = false;
    };
  }, [groupId]);

  const remember = useCallback(
    async (added: readonly string[]): Promise<void> => {
      // Dedupe before the cap and use the functional updater, so two calls
      // before a re-render don't drop the first call's keys or persist repeats.
      let next: string[] = [];
      setKeys((current) => {
        next = [...new Set([...current, ...added])].slice(-KEEP);
        return new Set(next);
      });
      await syncEngine.saveDraft(keyFor(groupId), next);
    },
    [groupId],
  );

  return { keys, remember };
}
