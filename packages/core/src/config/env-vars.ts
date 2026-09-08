/**
 * Environment variable storage helpers.
 *
 * Users' env vars live as a JSON map on `users.data.env_vars`. Values come in
 * one canonical object shape. Scope values are validated in this layer.
 *
 * See `context/explorations/env-var-access.md`.
 */

import { ENV_VAR_SCOPES, type EnvVarScope } from '../types/user';

export { ENV_VAR_SCOPES } from '../types/user';

/** Persisted shape inside `users.data.env_vars`. */
export interface StoredEnvVar {
  value_encrypted: string;
  scope: EnvVarScope;
  extra_config?: Record<string, unknown> | null;
}

const ENV_VAR_SCOPE_SET = new Set<EnvVarScope>(ENV_VAR_SCOPES);

/** Return whether a value is one of the two supported environment scopes. */
export function isValidEnvVarScope(scope: string): scope is EnvVarScope {
  return ENV_VAR_SCOPE_SET.has(scope as EnvVarScope);
}

/** Reject unsupported scopes at the service boundary. */
export function assertEnvVarScope(scope: string): asserts scope is EnvVarScope {
  if (!isValidEnvVarScope(scope)) {
    throw new Error(`Invalid env var scope '${scope}'. Valid values: ${ENV_VAR_SCOPES.join(', ')}.`);
  }
}

/** Validate and normalize one canonical persisted record. */
export function normalizeStoredEnvVar(raw: unknown): StoredEnvVar {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('Environment variable entry must be an object.');
  }

  const candidate = raw as Partial<StoredEnvVar>;
  if (typeof candidate.value_encrypted !== 'string' || candidate.value_encrypted.length === 0) {
    throw new Error('Environment variable entry is missing value_encrypted.');
  }
  if (typeof candidate.scope !== 'string' || !isValidEnvVarScope(candidate.scope)) {
    throw new Error('Environment variable entry has an unsupported scope.');
  }
  if (
    candidate.extra_config !== undefined &&
    candidate.extra_config !== null &&
    (typeof candidate.extra_config !== 'object' || Array.isArray(candidate.extra_config))
  ) {
    throw new Error('Environment variable extra_config must be an object or null.');
  }

  return {
    value_encrypted: candidate.value_encrypted,
    scope: candidate.scope,
    extra_config: candidate.extra_config ?? null,
  };
}

/**
 * Normalize a full map (skips malformed entries with a warning — same defensive
 * posture as the existing decrypt loop in env-resolver.ts).
 */
export function normalizeStoredEnvMap(
  raw: Record<string, unknown> | undefined
): Record<string, StoredEnvVar> {
  const out: Record<string, StoredEnvVar> = {};
  if (!raw) return out;
  for (const [key, value] of Object.entries(raw)) {
    try {
      out[key] = normalizeStoredEnvVar(value);
    } catch (err) {
      console.warn(`[env-vars] Skipping malformed env var entry ${key}:`, err);
    }
  }
  return out;
}
