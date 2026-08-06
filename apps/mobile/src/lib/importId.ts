/**
 * A mutation id that is the same every time for the same imported thing.
 *
 * Normal writes get a random `clientMutationId`; the point of it is that a
 * retry after a flaky network cannot double-post (ADR-005). An import needs
 * something stronger, because the duplicate does not come from a retry — it
 * comes from a person. They paste the same messages next week, or pick the
 * same CSV twice, and the second run has no memory of the first.
 *
 * So the id is derived from the thing itself. `expenses.client_mutation_id`
 * is UNIQUE and the write path already answers a repeat with `replayed`
 * rather than a second row, which means a re-import is a no-op at the only
 * layer that actually decides — the database. The screens also keep a local
 * list of what they have imported (lib/imported), but that is convenience: it
 * makes the duplicate visible instead of silently doing nothing, and it is
 * per-device, so it is not what the guarantee rests on.
 *
 * The group id is part of the seed on purpose. The same bank message imported
 * into two different groups is two real expenses, not one.
 */

import * as Crypto from 'expo-crypto';

import { uuidFromDigest } from './uuid8';

/** The stable id for one imported row, in one group. */
export async function importMutationId(groupId: string, seed: string): Promise<string> {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    `baaki:import:${groupId}:${seed}`,
  );
  return uuidFromDigest(digest);
}
