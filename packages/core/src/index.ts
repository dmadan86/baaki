/**
 * @baaki/core — the deterministic heart of Baaki.
 *
 * Zero runtime dependencies on React, Supabase or Node APIs (TDR §1): this
 * package is shared verbatim by the mobile app, the guest web-lite view and the
 * Deno edge functions, so all three compute identical money.
 */

export * from './money/index.js';
export * from './split/index.js';
export * from './balances/index.js';
export * from './simplify/index.js';
export * from './settlement/index.js';
export * from './sync/index.js';
export * from './notifications/index.js';
