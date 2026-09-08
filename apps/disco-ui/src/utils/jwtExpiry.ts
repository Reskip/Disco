/**
 * Client-side JWT expiry helpers.
 *
 * Thin re-export of `@disco-live/client/jwt`, which itself re-exports the
 * shared decoder from `@disco/core/utils/jwt`. The daemon-side
 * `resolveTokenExpiry` cascade uses the same implementation, so there is
 * exactly one decoder in the tree — no drift between client and server.
 *
 * We decode (NOT verify) the payload purely to learn when the token will be
 * rejected by the server, so we can schedule a proactive refresh. The server
 * is still the only party that validates signatures.
 */

export { decodeJwtExpMs, isExpiringSoon, msUntilExpiry } from '@disco-live/client/jwt';
