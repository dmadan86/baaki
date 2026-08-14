/**
 * Deciding whether an installed app is too old.
 *
 * Two different judgements, and they are not the same severity:
 *
 * A *suggested* update is a new version in the store. Nothing is wrong with
 * what somebody is holding; there is simply something better. It gets a banner
 * they can dismiss, and dismissing it must stick, or the banner becomes the
 * thing they resent rather than the thing they act on.
 *
 * A *required* update is a version we can no longer let talk to the server —
 * a client that computes money wrongly, or one whose sync protocol we have
 * stopped answering. That gets a wall, because letting it through would put
 * wrong numbers in a shared ledger that other people are reading.
 *
 * Everything here fails towards letting the app open. A version string we
 * cannot parse, a policy we could not fetch, a comparison we are unsure of —
 * all of them resolve to `none`. Blocking somebody out of their own ledger
 * because a check misfired is a far worse outcome than a stale client running
 * one day longer.
 */

/** What to do about the installed version. */
export enum UpdateDecision {
  None = 'none',
  Suggested = 'suggested',
  Required = 'required',
}

/** What the server says about a platform's builds. */
export interface ReleasePolicy {
  /** The newest build in the store. */
  readonly latestVersion: string;
  /** The oldest build still allowed to run. */
  readonly minimumVersion: string;
}

/**
 * Parse a dotted version into comparable parts.
 *
 * Returns null rather than a guess for anything that is not purely numeric
 * dotted segments — a build named `1.2.0-beta` is a shape we do not ship, and
 * inventing an ordering for it would make the answer confident and wrong.
 */
export function parseVersion(version: string): readonly number[] | null {
  const trimmed = version.trim();
  if (!/^\d+(\.\d+)*$/.test(trimmed)) return null;

  const parts = trimmed.split('.').map((part) => Number(part));
  return parts.some((part) => !Number.isSafeInteger(part)) ? null : parts;
}

/**
 * Compare two dotted versions: negative if `a` is older, positive if newer.
 *
 * Missing segments count as zero, so `1.2` and `1.2.0` are the same version —
 * the store shows one of them and app.json holds the other often enough that
 * treating them as different would produce an update prompt for no update.
 *
 * Returns null when either side is unparseable, so callers have to decide what
 * an unknown ordering means rather than receiving a silent 0.
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * What the app should do about the version it is running.
 *
 * A minimum above the latest is a policy that would block every build in
 * existence, including the one somebody would be sent to install. It is always
 * a mistake — a typo, or a minimum bumped before the release it names actually
 * shipped — so it is treated as one and ignored rather than obeyed.
 */
export function decideUpdate(installed: string, policy: ReleasePolicy): UpdateDecision {
  const belowMinimum = compareVersions(installed, policy.minimumVersion);
  const minimumIsReal = (compareVersions(policy.minimumVersion, policy.latestVersion) ?? 1) <= 0;
  if (minimumIsReal && belowMinimum !== null && belowMinimum < 0) return UpdateDecision.Required;

  const behindLatest = compareVersions(installed, policy.latestVersion);
  if (behindLatest !== null && behindLatest < 0) return UpdateDecision.Suggested;

  return UpdateDecision.None;
}
