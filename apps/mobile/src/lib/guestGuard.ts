/**
 * The guest ceilings, wired to this phone's guest (ADR-006 addendum).
 *
 * `@baaki/core`'s `guestGate` decides; this hook feeds it who is asking (a
 * guest, and when their account was made) and how many groups they are in, then
 * hands screens two guards to call before a write. A full user gets a null gate
 * and both guards wave everything through, so a screen can call them
 * unconditionally.
 *
 * The guard both answers and acts: when a guest may not do the thing, it sends
 * them to the account screen with the reason, and returns `true` so the caller
 * bails. The pattern at the call site is `if (guard.blockWrite()) return;`.
 */

import { useCallback, useMemo } from 'react';
import { router } from 'expo-router';

import {
  guestGate,
  guestGroupBlock,
  guestWriteBlock,
  type GuestBlock,
  type GuestGate,
} from '@baaki/core';

import { useGroups } from '@/data/hooks';
import { useAuth } from './auth';

export interface GuestGuard {
  /** Null for a full user — the limits do not apply to them. */
  gate: GuestGate | null;
  /**
   * Call before starting or joining a group. Sends the guest to the upgrade
   * screen and returns `true` when they may not; returns `false` to proceed.
   */
  blockAddGroup: () => boolean;
  /** The same, for any other write — add an expense, settle, edit. */
  blockWrite: () => boolean;
}

export function useGuestGuard(): GuestGuard {
  const { isGuest, session } = useAuth();
  const groups = useGroups();
  const createdAt = session?.user?.created_at ?? null;
  const groupCount = (groups.data ?? []).length;

  const gate = useMemo<GuestGate | null>(() => {
    if (!isGuest || !createdAt) return null;
    return guestGate({ createdAt, groupCount });
  }, [isGuest, createdAt, groupCount]);

  const send = useCallback((reason: GuestBlock) => {
    router.push(`/settings/account?reason=${reason}`);
  }, []);

  const blockAddGroup = useCallback((): boolean => {
    if (!gate) return false;
    const reason = guestGroupBlock(gate);
    if (!reason) return false;
    send(reason);
    return true;
  }, [gate, send]);

  const blockWrite = useCallback((): boolean => {
    if (!gate) return false;
    const reason = guestWriteBlock(gate);
    if (!reason) return false;
    send(reason);
    return true;
  }, [gate, send]);

  return { gate, blockAddGroup, blockWrite };
}
