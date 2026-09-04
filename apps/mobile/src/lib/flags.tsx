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
