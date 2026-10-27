/**
 * Fixed rules of the commerce modules (gift cards, finance directory). Operating limits come from the environment
 * (config/env.ts); the markup itself is changed in the admin dashboard and stored in the database.
 */

/** Default markup on the purchase cost: 3.5 % (in basis points). */
export const DEFAULT_MARKUP_BPS = 350;
/** The dashboard accepts 0 to 20 %. A markup is never negative, so the sale price never falls below cost. */
export const MAX_MARKUP_BPS = 2000;
/** Provider calls (catalog, quote, order) give up after this long. */
export const PROVIDER_TIMEOUT_MS = 10_000;
/** After this many provider failures in a row, new quotes are refused for CIRCUIT_OPEN_MS. */
export const CIRCUIT_FAILURES = 3;
export const CIRCUIT_OPEN_MS = 5 * 60_000;
/** Unused quotes are deleted after one day. */
export const QUOTE_RETENTION_MS = 86_400_000;
