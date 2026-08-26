/**
 * @waves/db — Prisma schema, migrations and the generated client.
 *
 * The mobile app never imports this: it talks to Supabase through supabase-js
 * (RLS-enforced) and the `/sync` edge function (TDR §2.0). Server-side code
 * (edge functions, jobs) imports the client from here.
 */

export type { PrismaClient } from '../generated/client/index.js';

/** Splitwise CSV → Waves group importer (parser + write path). */
export * from './import/splitwise';

/** Statuses that move the ledger — mirrors @waves/core `isSettled`. */
export const SETTLED_STATUSES = ['confirmed', 'auto_confirmed'] as const;

/** Ground-truth SQL helpers, callable from edge functions. */
export const SQL_FUNCTIONS = {
  groupBalancesTruth: 'baaki_group_balances_truth',
  groupPairwiseTruth: 'baaki_group_pairwise_truth',
  refreshGroupBalances: 'baaki_refresh_group_balances',
  isGroupMember: 'is_group_member',
  nextGroupSeq: 'baaki_next_group_seq',
} as const;
