/**
 * The server's check on a client's arithmetic (TDR §4).
 *
 * "**Never** trust client-computed shares: server recomputes from
 * `split_params` and rejects mismatches (`SHARE_MISMATCH`)."
 *
 * The recomputation is `computeShares`. This is the comparison that follows it,
 * and it lives here rather than in each edge function so there is exactly one
 * definition of what "agrees" means — including the case a hand-written check
 * tends to miss, where the client claims a share for somebody the server never
 * computed one for.
 */

import { SplitError, SplitErrorCode, type MemberId, type ShareMap } from './types';

/**
 * Compare the authoritative shares against what the client believed.
 *
 * `claimed` is the wire form: decimal strings, because JSON has no integers
 * this size. Passing `undefined` means the client made no claim, which is
 * allowed — an offline client that has recomputed nothing simply accepts
 * whatever the server decides.
 *
 * Throws `SplitError('SHARE_MISMATCH')` on the first disagreement, naming the
 * member and both numbers so the client can repair itself rather than guess.
 */
export function verifyClientShares(
  computed: ShareMap,
  claimed: Readonly<Record<MemberId, string | bigint>> | undefined,
): void {
  if (claimed === undefined) return;

  for (const [member, share] of computed) {
    const raw = claimed[member];
    if (raw === undefined) {
      throw new SplitError(
        SplitErrorCode.ShareMismatch,
        `Server computed ${share} for ${member}, client said nothing`,
      );
    }
    if (toBigInt(raw, member) !== share) {
      throw new SplitError(
        SplitErrorCode.ShareMismatch,
        `Server computed ${share} for ${member}, client said ${String(raw)}`,
      );
    }
  }

  // The other direction matters just as much: a client that invents a share for
  // somebody outside the split is wrong even though every share the server
  // computed happened to match.
  for (const member of Object.keys(claimed)) {
    if (!computed.has(member)) {
      throw new SplitError(
        SplitErrorCode.ShareMismatch,
        `Client claimed a share for ${member}, who is not in this split`,
      );
    }
  }
}

function toBigInt(value: string | bigint, member: MemberId): bigint {
  if (typeof value === 'bigint') return value;
  try {
    return BigInt(value);
  } catch {
    throw new SplitError(SplitErrorCode.ShareMismatch, `Client sent "${value}" as ${member}'s share`);
  }
}
