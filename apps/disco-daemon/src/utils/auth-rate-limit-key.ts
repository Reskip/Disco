/**
 * Composite key used by the express-rate-limit middleware on `/authentication`.
 *
 * - For POST /authentication the key is `${ip}|${username}` — keeping the
 *   per-account bucket separate from the per-IP bucket so an attacker
 *   rotating the username field can't reset the counter, and a real user
 *   moving between IPs (mobile / VPN) doesn't get locked out by someone
 *   else's failures on the same shared IP.
 * - For POST /authentication/refresh there is no username field on the body,
 *   so we bucket purely by IP.
 *
 * Trust ONLY Express's resolved `req.ip` here — `app.set('trust proxy', n)`
 * controls how `req.ip` is derived from X-Forwarded-For. Reading the
 * header directly would let any client spoof their key.
 */

import type { Request } from 'express';

export function buildAuthRateLimitKey(req: Request): string {
  const ip = (req.ip || 'unknown').toLowerCase();
  // `req.path` is mount-relative — when the limiter is mounted at
  // `/authentication`, a request to `/authentication/refresh` arrives here
  // with `req.path === '/refresh'`.
  if (req.path === '/refresh') return ip;
  const body = req.body as { username?: unknown } | undefined;
  const rawUsername = typeof body?.username === 'string' ? body.username : '';
  const username = rawUsername.trim().toLowerCase();
  return `${ip}|${username}`;
}
