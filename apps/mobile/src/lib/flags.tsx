/**
 * Feature flags on the phone.
 *
 * The variant is computed here, not fetched. The server hands over the flag's
 * configuration — is it on, how wide is the rollout, what are the arms — and
 * `variantFor` from @waves/core turns that plus the profile id into an answer,
 * using the same hash the database uses in `waves_variant`. So a screen never
 * waits on a round trip to know what to draw, and a phone with no signal shows
 * the same thing it showed yesterday (ADR-005).
 *
 * Off is the fallback for everything: no session, no cached config, a failed
 * fetch. A feature that fails open is one that appears for people it was never
 * rolled out to, which is the same as having no rollout at all.
 */

import { useQuery } from '@tanstack/react-query';

import { variantFor, type FeatureFlag } from '@waves/core';

import { useAuth } from '@/lib/auth';
import { backend } from '@/lib/backend';

interface FlagRow {
  key: string;
  enabled: boolean;
  rollout_percent: number;
  variants: string[];
}

async function fetchFlags(): Promise<FeatureFlag[]> {
  const { data, error } = await backend
    .from('feature_flags')
    .select('key, enabled, rollout_percent, variants');

  // A flag table that cannot be read is not worth an error state on somebody's
  // expense screen. Every caller falls back to off.
  if (error) return [];

  return (data ?? []).map((row: FlagRow) => ({
    key: row.key,
    enabled: row.enabled,
    rolloutPercent: row.rollout_percent,
    variants: row.variants,
  }));
}

function useFlags() {
  return useQuery({
    queryKey: ['feature-flags'],
    queryFn: fetchFlags,
    // Flags change when somebody in the console changes them, which is rare
    // and never urgent. An hour of staleness costs nothing; refetching on
    // every screen would cost a request per navigation.
    staleTime: 60 * 60 * 1000,
    retry: 1,
  });
}

/**
 * Which arm this person is on, or null for "not in this experiment".
 *
 * Null is not the control arm. Somebody outside the rollout should get whatever
 * the app did before the flag existed — treat null as "behave as before", never
 * as "show the control variant".
 */
export function useFlagVariant(key: string): string | null {
  const { profile } = useAuth();
  const { data } = useFlags();
  if (!profile?.id || !data) return null;

  const flag = data.find((candidate) => candidate.key === key);
  return flag ? variantFor(flag, profile.id) : null;
}

/** For a plain on/off switch, where the arms carry no meaning of their own. */
export function useFlagEnabled(key: string): boolean {
  return useFlagVariant(key) !== null;
}

/**
 * The arm, *and* whether the table has actually been read.
 *
 * `useFlagVariant` collapses "not in this experiment" and "we have not managed
 * to ask yet" into the same null, which is right for a screen — both mean draw
 * the app as it was before the flag existed, and a button that flickers in when
 * a query resolves is worse than one that never appears.
 *
 * It is wrong for anything that *tears something down* when the answer is no.
 * Unregistering a scheduled background job because a phone happened to be in a
 * tunnel at launch would switch a feature off for a reason that is not about
 * the feature at all, and switch it back on a minute later, which is churn
 * dressed up as caution. `settled` is what tells those two apart: true only
 * when the flag table came back, so a caller can act on "off" and leave "we do
 * not know yet" alone.
 */
export function useFlagVerdict(key: string): { variant: string | null; settled: boolean } {
  const { profile } = useAuth();
  const { data, isSuccess } = useFlags();
  // No profile is a settled answer, not a pending one: the variant is a hash of
  // the account id, so there is nothing to wait for until somebody signs in.
  if (!profile?.id) return { variant: null, settled: true };
  if (!isSuccess || !data) return { variant: null, settled: false };

  const flag = data.find((candidate) => candidate.key === key);
  return { variant: flag ? variantFor(flag, profile.id) : null, settled: true };
}
