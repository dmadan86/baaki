/**
 * Which side of an experiment somebody is on.
 *
 * Decided by hashing, never by storing. A stored assignment is a row that has
 * to be written before the feature can render — on a phone that is offline
 * (ADR-005), for a guest who has no server round trip to spare, at the exact
 * moment the screen needs an answer. Hashing has none of that: the same person
 * and the same flag give the same answer on every device, forever, with no
 * write and no network.
 *
 * It also makes the analysis a join rather than a pipeline. Because the bucket
 * is a pure function of ids the database already has, the console can compute
 * "what did the treatment group do" straight from `profiles` — no exposure
 * events, no second source of truth to drift.
 *
 * That last property is why this file matters more than its size suggests: the
 * app decides what to show from this function, and the console counts what
 * happened using the *same* rule reimplemented in plpgsql. If the two ever
 * disagree, every experiment result is quietly wrong — not missing, wrong. The
 * shared fixtures in `BUCKET_FIXTURES` are asserted by both test suites for
 * exactly that reason.
 *
 * FNV-1a, 32-bit. Chosen because it is a dozen lines in both languages with no
 * dependency and no ambiguity — not for cryptographic quality, which an
 * experiment bucket does not need. It is not a secret and must not be used as
 * one.
 */

const FNV_OFFSET = 2166136261;
const FNV_PRIME = 16777619;

/**
 * A stable 0–99 from any string.
 *
 * `Math.imul` because a 32-bit multiply overflows a double at this size, and
 * `>>> 0` to keep it unsigned — the plpgsql side takes `% 4294967296` for the
 * same reason. UTF-8 bytes rather than code units so a non-ASCII flag key
 * hashes identically in both.
 */
export function bucketOf(input: string): number {
  let hash = FNV_OFFSET;
  for (const byte of new TextEncoder().encode(input)) {
    hash ^= byte;
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % 100;
}

export interface FeatureFlag {
  readonly key: string;
  readonly enabled: boolean;
  /** 0–100. How much of the population is in the experiment at all. */
  readonly rolloutPercent: number;
  /** At least two. The first is the control by convention, never by force. */
  readonly variants: readonly string[];
}

/**
 * The variant this person sees, or null for "not in this experiment".
 *
 * Null is not the control group and the caller must not treat it as one. A
 * person outside the rollout should see whatever the app did before the flag
 * existed; folding them into the control would put people who were never
 * enrolled into a number that is supposed to describe people who were.
 *
 * Rollout and variant are hashed from different strings on purpose. Reusing one
 * bucket for both ties them together — widening the rollout from 10% to 20%
 * would then hand every newly-included person the same variant, and the split
 * would be 100/0 in the new cohort while looking fine in aggregate.
 */
export function variantFor(flag: FeatureFlag, profileId: string): string | null {
  if (!flag.enabled) return null;
  if (flag.variants.length < 2) return null;
  if (bucketOf(`${flag.key}:${profileId}`) >= flag.rolloutPercent) return null;
  return flag.variants[bucketOf(`${flag.key}:${profileId}:variant`) % flag.variants.length] ?? null;
}

/** Convenience for a plain on/off flag: in the rollout at all, either variant. */
export function isEnabled(flag: FeatureFlag, profileId: string): boolean {
  return variantFor(flag, profileId) !== null;
}

/**
 * Inputs whose buckets both implementations must agree on.
 *
 * Asserted by `packages/core/test/flags.test.ts` against this TypeScript and by
 * `packages/db/test/featureFlags.test.ts` against the plpgsql. Two suites, one
 * table of numbers: if a change breaks the agreement, one of them fails.
 *
 * The values are whatever FNV-1a produces — they are not chosen, they are
 * recorded. Changing the hash changes them, and changing them reassigns every
 * user in every running experiment, which is the point of writing them down.
 */
export const BUCKET_FIXTURES: readonly { input: string; bucket: number }[] = [
  // Literals, deliberately. Calling `bucketOf` to fill this in would make the
  // table agree with itself by construction and prove nothing about plpgsql.
  { input: '', bucket: 61 },
  { input: 'a', bucket: 20 },
  { input: 'itemized_receipts:00000000-0000-0000-0000-000000000000', bucket: 22 },
  { input: 'itemized_receipts:00000000-0000-0000-0000-000000000000:variant', bucket: 17 },
  { input: 'baaki', bucket: 47 },
  // Non-ASCII, because the two implementations agree only if both hash UTF-8
  // bytes. A plpgsql `ascii()` over characters would pass every other row here
  // and fail this one.
  { input: 'பாக்கி', bucket: 34 },
];
