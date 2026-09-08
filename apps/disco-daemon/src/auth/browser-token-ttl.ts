/**
 * Browser authentication lifetimes.
 *
 * Keep these values in one place: Feathers' JWT strategy, the login hook and
 * the refresh endpoint must issue tokens with identical lifetimes.
 */
export const BROWSER_ACCESS_TOKEN_TTL = '1h' as const;
export const BROWSER_REFRESH_TOKEN_TTL = '30d' as const;
