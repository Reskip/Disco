/**
 * Compatibility re-export for daemon call sites. Codex's auth.json schema has
 * one pure owner in core so import validation and executor inspection cannot
 * drift apart.
 */
export * from '@disco/core/codex/auth-file';
