/**
 * @baaki/core — the deterministic heart of Baaki.
 *
 * Zero runtime dependencies on React, Supabase or Node APIs (TDR §1): this
 * package is shared verbatim by the mobile app, the guest web-lite view and the
 * Deno edge functions, so all three compute identical money.
 */

export * from './money/index';
export * from './split/index';
export * from './balances/index';
export * from './simplify/index';
export * from './settlement/index';
export * from './sync/index';
export * from './receipt/index';
export * from './notifications/index';
export * from './import/index';
