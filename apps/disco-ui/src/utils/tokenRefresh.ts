/**
 * Token refresh utilities for authentication
 *
 * Centralizes the logic for refreshing JWT tokens using refresh tokens.
 * Used by both useAuth and useDiscoClient hooks to avoid duplication.
 */

import type { DiscoClient, User } from '@disco-live/client';

export const ACCESS_TOKEN_KEY = 'disco-access-token';
export const REFRESH_TOKEN_KEY = 'disco-refresh-token';
export const FEATHERS_ACCESS_TOKEN_KEY = 'feathers-jwt';
export const TOKENS_CHANGED_EVENT = 'disco:tokens-changed';

export interface RefreshResult {
  accessToken: string;
  refreshToken?: string;
  /**
   * Full user object — matches the shape returned by POST /authentication.
   * Importantly includes `must_change_password` so the UI's force-password-
   * change guard (App.tsx) keeps working across token refreshes; previously
   * the field was stripped here and on the server, breaking that flow.
   */
  user: User;
}

/**
 * Refresh access token using refresh token
 *
 * @param client - Disco client instance
 * @param refreshToken - Current refresh token
 * @returns New access token, optional new refresh token, and user info
 */
export async function refreshAccessToken(
  client: DiscoClient,
  refreshToken: string
): Promise<RefreshResult> {
  const result = await client.service('authentication/refresh').create({
    refreshToken,
  });

  return result as RefreshResult;
}

/**
 * Store authentication tokens in localStorage
 *
 * @param accessToken - Access token to store
 * @param refreshToken - Optional refresh token to store (if rotated)
 */
export function storeTokens(accessToken: string, refreshToken?: string): void {
  localStorage.setItem(ACCESS_TOKEN_KEY, accessToken);
  if (refreshToken) {
    localStorage.setItem(REFRESH_TOKEN_KEY, refreshToken);
  }
  window.dispatchEvent(new Event(TOKENS_CHANGED_EVENT));
}

/**
 * Get stored refresh token from localStorage
 *
 * @returns Refresh token or null if not found
 */
export function getStoredRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

/**
 * Get stored access token from localStorage
 *
 * @returns Access token or null if not found
 */
export function getStoredAccessToken(): string | null {
  return localStorage.getItem(ACCESS_TOKEN_KEY);
}

/**
 * Clear all authentication tokens from localStorage
 */
export function clearTokens(): void {
  localStorage.removeItem(ACCESS_TOKEN_KEY);
  localStorage.removeItem(REFRESH_TOKEN_KEY);
  // Feathers' socket authentication client keeps its own access-token copy.
  // Leaving it behind makes a logout/login cycle capable of reviving a stale
  // JWT on the next client instance, especially after a mobile BFCache restore.
  localStorage.removeItem(FEATHERS_ACCESS_TOKEN_KEY);
  window.dispatchEvent(new Event(TOKENS_CHANGED_EVENT));
}

/**
 * Refresh and store tokens in one operation
 *
 * Convenience function that combines refreshAccessToken and storeTokens.
 *
 * @param client - Disco client instance
 * @param refreshToken - Current refresh token
 * @returns Refresh result with new tokens and user info
 */
export async function refreshAndStoreTokens(
  client: DiscoClient,
  refreshToken: string
): Promise<RefreshResult> {
  const result = await refreshAccessToken(client, refreshToken);
  storeTokens(result.accessToken, result.refreshToken);
  return result;
}
