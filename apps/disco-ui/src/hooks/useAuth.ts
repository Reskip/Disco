// @ts-nocheck - Complex auth flow with conditional null states
/**
 * Authentication Hook
 *
 * Manages user authentication state and provides login/logout functions
 */

import type { User } from '@disco-live/client';
import { createRestClient } from '@disco-live/client';
import { useCallback, useEffect, useState } from 'react';
import { getDaemonUrl } from '../config/daemon';
import { isDefiniteAuthFailure, isTransientConnectionError } from '../utils/authErrors';
import { isExpiringSoon, msUntilExpiry } from '../utils/jwtExpiry';
import {
  dispatchTokensRefreshed,
  RefreshUnrecoverableError,
  refreshTokensSingleFlight,
  resetRefreshFailureState,
  TOKENS_REFRESH_UNRECOVERABLE_EVENT,
  TOKENS_REFRESHED_EVENT,
} from '../utils/singleFlightRefresh';
import {
  clearTokens,
  getStoredAccessToken,
  getStoredRefreshToken,
  type RefreshResult,
  storeTokens,
} from '../utils/tokenRefresh';

interface AuthState {
  user: User | null;
  accessToken: string | null;
  authenticated: boolean;
  loading: boolean;
  error: string | null;
}

interface UseAuthReturn extends AuthState {
  login: (username: string, password: string) => Promise<boolean>;
  logout: () => Promise<void>;
  reAuthenticate: () => Promise<void>;
}

const UNEXPECTED_LOGIN_RESPONSE_MESSAGE =
  'The Disco service returned an unexpected response while signing in. Check that the service URL is correct and the server is reachable, then try again.';

const ACCESS_TOKEN_REFRESH_BUFFER_MS = 2 * 60_000;
const AUTO_REFRESH_MIN_DELAY_MS = 1_000;
const AUTO_REFRESH_FALLBACK_DELAY_MS = 5 * 60_000;
const AUTO_REFRESH_RETRY_BASE_MS = 5_000;
const AUTO_REFRESH_RETRY_MAX_MS = 60_000;

async function refreshStoredBrowserTokens(): Promise<boolean> {
  const refreshToken = getStoredRefreshToken();
  if (!refreshToken) return false;

  const client = await createRestClient(getDaemonUrl());
  await refreshTokensSingleFlight(client, refreshToken);
  return true;
}

function isJsonParseFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const message =
    error instanceof Error ? error.message : String((error as { message?: unknown }).message ?? '');
  return /json parsing error/i.test(message) || /unexpected token.*json/i.test(message);
}

function loginErrorMessage(error: unknown): string {
  if (isJsonParseFailure(error)) {
    return UNEXPECTED_LOGIN_RESPONSE_MESSAGE;
  }

  if (isTransientConnectionError(error)) {
    return 'Unable to reach the Disco service. Check your connection and try again.';
  }

  return error instanceof Error ? error.message : 'Login failed';
}

/**
 * Authentication hook
 */
export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    user: null,
    accessToken: null,
    authenticated: false,
    loading: true,
    error: null,
  });

  /**
   * Re-authenticate using stored token (with automatic refresh)
   * Retries up to 3 times to handle daemon restarts gracefully
   */
  const reAuthenticate = useCallback(async (retryCount = 0) => {
    const MAX_RETRIES = 5;
    setState((prev) => ({ ...prev, loading: true, error: null }));

    const storedAccessToken = getStoredAccessToken();
    const storedRefreshToken = getStoredRefreshToken();
    const hasStoredTokens = !!storedAccessToken || !!storedRefreshToken;

    async function authenticateWithStoredTokens(
      client: Awaited<ReturnType<typeof createRestClient>>
    ) {
      if (!storedAccessToken && !storedRefreshToken) return false;

      // Try to authenticate with stored access token first
      if (storedAccessToken) {
        try {
          const result = await client.authenticate({
            strategy: 'jwt',
            accessToken: storedAccessToken,
          });

          // JWT re-authentication returns a newly-issued browser token pair.
          // Persist it before publishing authenticated state; otherwise raw
          // HTTP paths (uploads and protected file reads) keep using the old
          // localStorage token until it expires even though React and the
          // socket already hold the fresh token.
          storeTokens(result.accessToken, result.refreshToken);
          resetRefreshFailureState();

          setState({
            user: result.user,
            accessToken: result.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });
          dispatchTokensRefreshed(result as RefreshResult);

          return true;
        } catch (accessTokenError) {
          // Access token expired or invalid, try refresh token
          if (!isDefiniteAuthFailure(accessTokenError)) throw accessTokenError;
        }
      }

      // Access token expired or missing, try refresh token
      if (storedRefreshToken) {
        try {
          const refreshResult = await refreshTokensSingleFlight(client, storedRefreshToken);

          setState({
            user: refreshResult.user,
            accessToken: refreshResult.accessToken,
            authenticated: true,
            loading: false,
            error: null,
          });

          return true;
        } catch (refreshError) {
          // Refresh token also expired or invalid
          if (
            !isDefiniteAuthFailure(refreshError) &&
            !(refreshError instanceof RefreshUnrecoverableError)
          ) {
            throw refreshError;
          }
        }
      }

      return false;
    }

    try {
      const client = await createRestClient(getDaemonUrl());

      if (!hasStoredTokens) {
        setState({
          user: null,
          accessToken: null,
          authenticated: false,
          loading: false,
          error: null,
        });
        return;
      }

      if (await authenticateWithStoredTokens(client)) return;

      // Both tokens invalid or expired — expected when refresh token hits its TTL.
      clearTokens();
      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: null,
      });
    } catch (error) {
      // Connection or authentication error - retry if daemon just restarted
      const isConnectionError = isTransientConnectionError(error);

      if (isConnectionError && retryCount < MAX_RETRIES) {
        const delay = Math.min(2000 * 1.5 ** retryCount, 10000); // Exponential backoff: 2s, 3s, 4.5s, 6.75s, 10s (capped)
        await new Promise((resolve) => setTimeout(resolve, delay));
        return reAuthenticate(retryCount + 1);
      }

      if (isDefiniteAuthFailure(error) && !isConnectionError) {
        console.error('Authentication failure, clearing tokens:', error);
        clearTokens();
      }

      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: isConnectionError ? 'Connection lost - waiting for daemon...' : null,
      });
    }
  }, []);

  // Try to re-authenticate on mount (using stored token)
  useEffect(() => {
    reAuthenticate();
  }, [reAuthenticate]);

  // Browser-lifecycle recovery, especially for mobile Safari/Chrome.
  //
  // Mobile browsers can freeze timers, evict the socket, or restore a page
  // from BFCache without remounting React. `visibilitychange` alone does not
  // cover those paths consistently, so every signal that means "the user can
  // interact again" runs the same cheap expiry check. Concurrent signals are
  // collapsed here and the refresh request itself is also single-flight.
  useEffect(() => {
    let disposed = false;
    let recoveryInFlight: Promise<void> | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const clearRetryTimer = () => {
      if (retryTimer !== null) {
        clearTimeout(retryTimer);
        retryTimer = null;
      }
    };

    const recover = () => {
      if (disposed || document.visibilityState === 'hidden' || recoveryInFlight) return;

      recoveryInFlight = (async () => {
        const storedAccess = getStoredAccessToken();
        const storedRefresh = getStoredRefreshToken();
        if (!storedAccess && !storedRefresh) return;

        // Auth state may have been interrupted by a daemon/network outage.
        // Let the full path restore the user object as well as the token.
        if (!state.authenticated) {
          await reAuthenticate();
          return;
        }

        // A healthy token needs no network request. The socket hook separately
        // reconnects its transport on the same wake signals.
        if (storedAccess && !isExpiringSoon(storedAccess, ACCESS_TOKEN_REFRESH_BUFFER_MS)) {
          return;
        }

        try {
          const refreshed = await refreshStoredBrowserTokens();
          if (!refreshed) await reAuthenticate();
        } catch (error) {
          if (error instanceof RefreshUnrecoverableError) return;

          // A phone commonly resumes before Wi-Fi/cellular is usable. Keep the
          // session and retry shortly instead of turning that momentary state
          // into a logout.
          if (isTransientConnectionError(error)) {
            clearRetryTimer();
            retryTimer = setTimeout(recover, AUTO_REFRESH_RETRY_BASE_MS);
            return;
          }

          await reAuthenticate();
        }
      })().finally(() => {
        recoveryInFlight = null;
      });
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') recover();
    };

    document.addEventListener('visibilitychange', handleVisibilityChange);
    window.addEventListener('pageshow', recover);
    window.addEventListener('focus', recover);
    window.addEventListener('online', recover);

    return () => {
      disposed = true;
      clearRetryTimer();
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      window.removeEventListener('pageshow', recover);
      window.removeEventListener('focus', recover);
      window.removeEventListener('online', recover);
    };
  }, [state.authenticated, reAuthenticate]);

  // Poll for daemon availability when we have tokens but aren't authenticated.
  // This handles the case where the daemon restarts and we need to reconnect
  // without a user-driven event to trigger it. Split from the visibility
  // effect so that visibility-listener setup/teardown isn't churned every
  // time `state.loading` flips.
  useEffect(() => {
    if (state.authenticated || state.loading) return;

    const hasTokens = getStoredAccessToken() || getStoredRefreshToken();
    if (!hasTokens) return;

    const pollInterval = setInterval(() => {
      reAuthenticate();
    }, 3000); // Poll every 3 seconds

    return () => clearInterval(pollInterval);
  }, [state.authenticated, state.loading, reAuthenticate]);

  // Auto-refresh the access token before it expires.
  //
  // Strategy: decode the `exp` claim on the current access token and schedule
  // a single setTimeout for (exp - REFRESH_BUFFER). When it fires, refresh;
  // the state update then re-runs this effect with the new token, which
  // schedules the next tick. This removes the historic drift bug where the
  // refresh interval was hardcoded independently of the server's TTL.
  useEffect(() => {
    if (!state.authenticated || !state.accessToken) return;

    let disposed = false;
    let retryAttempt = 0;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number, callback: () => void) => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(callback, delay);
    };

    const attemptRefresh = async () => {
      if (disposed) return;

      try {
        const refreshed = await refreshStoredBrowserTokens();
        if (!refreshed) return;
        retryAttempt = 0;
        // State sync happens via TOKENS_REFRESHED_EVENT listener below; the
        // fresh access token reruns this effect and schedules the next cycle.
      } catch (error) {
        if (error instanceof RefreshUnrecoverableError) return;

        console.error('Failed to auto-refresh token:', error);
        const retryDelay = Math.min(
          AUTO_REFRESH_RETRY_BASE_MS * 2 ** retryAttempt,
          AUTO_REFRESH_RETRY_MAX_MS
        );
        retryAttempt += 1;
        setState((prev) => ({
          ...prev,
          error: isTransientConnectionError(error)
            ? 'Connection lost - waiting for daemon...'
            : prev.error,
        }));
        schedule(retryDelay, () => void attemptRefresh());
      }
    };

    const untilExp = msUntilExpiry(state.accessToken);
    const initialDelay =
      untilExp === null
        ? AUTO_REFRESH_FALLBACK_DELAY_MS
        : Math.max(AUTO_REFRESH_MIN_DELAY_MS, untilExp - ACCESS_TOKEN_REFRESH_BUFFER_MS);
    schedule(initialDelay, () => void attemptRefresh());

    return () => {
      disposed = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [state.authenticated, state.accessToken]);

  // When the single-flight refresh helper completes from a non-React path
  // (e.g. the socket-client 401-retry hook, or a concurrent refresh in
  // useDiscoClient), sync our React state so the next render uses the fresh
  // token and the auto-refresh effect re-schedules around the new `exp`.
  useEffect(() => {
    const handleRefreshed = (event: Event) => {
      const detail = (event as CustomEvent<RefreshResult>).detail;
      if (!detail) return;
      setState((prev) => ({
        ...prev,
        accessToken: detail.accessToken,
        user: detail.user,
        authenticated: true,
        loading: false,
        error: null,
      }));
    };

    window.addEventListener(TOKENS_REFRESHED_EVENT, handleRefreshed);
    return () => window.removeEventListener(TOKENS_REFRESHED_EVENT, handleRefreshed);
  }, []);

  // When the single-flight refresh helper determines the refresh token is
  // permanently dead (e.g. the server returned 401 / NotAuthenticated from
  // the refresh endpoint), clear tokens and flip to unauthenticated. Without
  // this, the socket around-hook and connect-handler would each re-throw
  // the original auth error without cleanup, and a page reload would be the
  // only way to escape the resulting refresh/reconnect loop.
  useEffect(() => {
    const handleUnrecoverable = () => {
      clearTokens();
      setState({
        user: null,
        accessToken: null,
        authenticated: false,
        loading: false,
        error: '登录状态已过期，请重新登录。',
      });
    };

    window.addEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, handleUnrecoverable);
    return () =>
      window.removeEventListener(TOKENS_REFRESH_UNRECOVERABLE_EVENT, handleUnrecoverable);
  }, []);

  /** Login with a local Disco username and password. */
  const login = async (username: string, password: string): Promise<boolean> => {
    setState((prev) => ({ ...prev, loading: true, error: null }));

    try {
      const client = await createRestClient(getDaemonUrl());

      // Authenticate
      const result = await client.authenticate({
        strategy: 'local',
        username: username.trim().toLowerCase(),
        password,
      });

      // Store both access and refresh tokens
      storeTokens(result.accessToken, result.refreshToken);

      // Fresh session — clear any stale "refresh is dead" latch from a
      // previous login so the new refresh token isn't rejected before it
      // ever gets tried.
      resetRefreshFailureState();

      setState({
        user: result.user,
        accessToken: result.accessToken,
        authenticated: true,
        loading: false,
        error: null,
      });
      dispatchTokensRefreshed(result);

      return true;
    } catch (error) {
      console.error('❌ Login failed:', error);
      const userFacingMessage = loginErrorMessage(error);
      const rawMessage = error instanceof Error ? error.message : 'Login failed';
      console.error('❌ Error message:', rawMessage);
      setState((prev) => ({
        ...prev,
        loading: false,
        error: userFacingMessage,
      }));
      return false;
    }
  };

  const logout = async () => {
    clearTokens();
    setState({
      user: null,
      accessToken: null,
      authenticated: false,
      loading: false,
      error: null,
    });
  };

  return {
    ...state,
    login,
    logout,
    reAuthenticate,
  };
}
