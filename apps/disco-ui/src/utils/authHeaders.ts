import { getStoredAccessToken } from './tokenRefresh';

export function getDiscoAccessToken(): string | null {
  if (typeof window === 'undefined') return null;
  return getStoredAccessToken() ?? localStorage.getItem('feathers-jwt');
}

/** Get auth headers for daemon REST calls. */
export function getAuthHeaders(): HeadersInit {
  const token = getDiscoAccessToken();
  return {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

/**
 * Decode the current user's id from the active Disco access token.
 *
 * Used by artifact runtime-query bridges to fail closed before executing a
 * query intended for another user. Falls back to the legacy Feathers token for
 * older sessions that have not migrated to the access/refresh token pair yet.
 */
export function getCurrentUserIdFromJwt(): string | null {
  const payload = getCurrentJwtClaims();
  return typeof payload?.sub === 'string' ? payload.sub : null;
}

/** Stable tenant identity for account-scoped browser caches. */
export function getCurrentTenantIdFromJwt(): string | null {
  const payload = getCurrentJwtClaims();
  return typeof payload?.tenant_id === 'string' ? payload.tenant_id : null;
}

function getCurrentJwtClaims(): Record<string, unknown> | null {
  const token = getDiscoAccessToken();
  if (!token) return null;
  try {
    const parts = token.split('.');
    if (parts.length < 2) return null;
    let b64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (b64.length % 4 !== 0) b64 += '=';
    const payload = JSON.parse(atob(b64));
    return payload && typeof payload === 'object' ? payload : null;
  } catch {
    return null;
  }
}
