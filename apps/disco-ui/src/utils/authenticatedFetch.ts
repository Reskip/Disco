import { createRestClient } from '@disco-live/client';
import { getDaemonUrl } from '../config/daemon';
import { isDefiniteAuthFailure, isTransientConnectionError } from './authErrors';
import { isExpiringSoon, msUntilExpiry } from './jwtExpiry';
import { RefreshUnrecoverableError, refreshTokensSingleFlight } from './singleFlightRefresh';
import { getStoredAccessToken, getStoredRefreshToken } from './tokenRefresh';

const REQUEST_REFRESH_BUFFER_MS = 60_000;

export interface FreshAccessTokenOptions {
  daemonUrl?: string;
  forceRefresh?: boolean;
}

function userFacingAuthError(error: unknown): Error {
  if (error instanceof RefreshUnrecoverableError || isDefiniteAuthFailure(error)) {
    return new Error('登录状态已过期，请重新登录。', { cause: error });
  }
  if (isTransientConnectionError(error)) {
    return new Error('连接暂时中断，请稍后重试。', { cause: error });
  }
  return error instanceof Error ? error : new Error('身份验证失败，请重新登录。');
}

/**
 * Return the current browser access token, refreshing it first when it is
 * expired (or within the refresh buffer). Callers that just received a 401
 * can force a refresh regardless of the token's decoded expiry.
 */
export async function getFreshAccessToken(
  options: FreshAccessTokenOptions = {}
): Promise<string | null> {
  const { daemonUrl = getDaemonUrl(), forceRefresh = false } = options;
  const accessToken = getStoredAccessToken();
  const refreshToken = getStoredRefreshToken();

  if (!refreshToken) return accessToken;
  if (!forceRefresh && accessToken && !isExpiringSoon(accessToken, REQUEST_REFRESH_BUFFER_MS)) {
    return accessToken;
  }

  try {
    const client = await createRestClient(daemonUrl);
    const refreshed = await refreshTokensSingleFlight(client, refreshToken);
    return refreshed.accessToken;
  } catch (error) {
    // A still-valid token is better than failing an otherwise healthy request
    // merely because the proactive refresh endpoint had a transient problem.
    const remaining = accessToken ? msUntilExpiry(accessToken) : null;
    if (
      !forceRefresh &&
      accessToken &&
      remaining !== null &&
      remaining > 0 &&
      isTransientConnectionError(error)
    ) {
      return accessToken;
    }
    throw userFacingAuthError(error);
  }
}

function headersWithAccessToken(headers: HeadersInit | undefined, accessToken: string | null) {
  const authenticatedHeaders = new Headers(headers);
  if (accessToken) authenticatedHeaders.set('Authorization', `Bearer ${accessToken}`);
  return authenticatedHeaders;
}

/**
 * Fetch a protected Disco HTTP endpoint with the latest browser token.
 * A 401 triggers one single-flight refresh and one replay of the request.
 */
export async function authenticatedFetch(
  input: RequestInfo | URL,
  init: RequestInit = {},
  options: Pick<FreshAccessTokenOptions, 'daemonUrl'> = {}
): Promise<Response> {
  const request = async (accessToken: string | null) =>
    fetch(input, {
      ...init,
      headers: headersWithAccessToken(init.headers, accessToken),
    });

  const accessToken = await getFreshAccessToken(options);
  const response = await request(accessToken);
  if (response.status !== 401) return response;

  const refreshedAccessToken = await getFreshAccessToken({
    ...options,
    forceRefresh: true,
  });
  const retried = await request(refreshedAccessToken);
  if (retried.status === 401) {
    throw new Error('登录状态已过期，请重新登录。');
  }
  return retried;
}
