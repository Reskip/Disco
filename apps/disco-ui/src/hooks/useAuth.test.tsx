import { createRestClient } from '@disco-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resetRefreshFailureState } from '../utils/singleFlightRefresh';
import { useAuth } from './useAuth';

vi.mock('@disco-live/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@disco-live/client')>()),
  createRestClient: vi.fn(),
}));

function tokenExpiringAt(expMs: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(expMs / 1000) }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `e30.${payload}.signature`;
}

describe('useAuth stored-token re-authentication', () => {
  beforeEach(() => {
    localStorage.clear();
    resetRefreshFailureState();
    vi.mocked(createRestClient).mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('persists the fresh browser token pair returned by JWT re-authentication', async () => {
    const freshAccessToken = tokenExpiringAt(Date.now() + 15 * 60_000);
    localStorage.setItem('disco-access-token', tokenExpiringAt(Date.now() + 5 * 60_000));
    localStorage.setItem('disco-refresh-token', 'old-refresh-token');
    const authenticate = vi.fn().mockResolvedValue({
      accessToken: freshAccessToken,
      refreshToken: 'fresh-refresh-token',
      user: { user_id: 'user-1', username: 'member', role: 'member' },
    });
    vi.mocked(createRestClient).mockResolvedValue({ authenticate } as never);

    const { result, unmount } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    expect(authenticate).toHaveBeenCalledWith({
      strategy: 'jwt',
      accessToken: expect.any(String),
    });
    expect(localStorage.getItem('disco-access-token')).toBe(freshAccessToken);
    expect(localStorage.getItem('disco-refresh-token')).toBe('fresh-refresh-token');
    expect(result.current.accessToken).toBe(freshAccessToken);
    unmount();
  });

  it('refreshes an expired access token when a mobile page is restored from BFCache', async () => {
    const initialAccessToken = tokenExpiringAt(Date.now() + 60 * 60_000);
    const refreshedAccessToken = tokenExpiringAt(Date.now() + 60 * 60_000);
    localStorage.setItem('disco-access-token', initialAccessToken);
    localStorage.setItem('disco-refresh-token', 'initial-refresh-token');

    const authenticate = vi.fn().mockResolvedValue({
      accessToken: initialAccessToken,
      refreshToken: 'initial-refresh-token',
      user: { user_id: 'user-1', username: 'member', role: 'member' },
    });
    const refreshCreate = vi.fn().mockResolvedValue({
      accessToken: refreshedAccessToken,
      refreshToken: 'rotated-refresh-token',
      user: { user_id: 'user-1', username: 'member', role: 'member' },
    });
    vi.mocked(createRestClient).mockResolvedValue({
      authenticate,
      service: vi.fn(() => ({ create: refreshCreate })),
    } as never);

    const { result, unmount } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));

    localStorage.setItem('disco-access-token', tokenExpiringAt(Date.now() - 1_000));
    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });

    await waitFor(() => expect(refreshCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.accessToken).toBe(refreshedAccessToken));
    expect(localStorage.getItem('disco-refresh-token')).toBe('rotated-refresh-token');
    expect(result.current.authenticated).toBe(true);
    unmount();
  });

  it('keeps the session and retries when connectivity returns after a mobile wake', async () => {
    const initialAccessToken = tokenExpiringAt(Date.now() + 60 * 60_000);
    const refreshedAccessToken = tokenExpiringAt(Date.now() + 60 * 60_000);
    localStorage.setItem('disco-access-token', initialAccessToken);
    localStorage.setItem('disco-refresh-token', 'refresh-token');

    const authenticate = vi.fn().mockResolvedValue({
      accessToken: initialAccessToken,
      refreshToken: 'refresh-token',
      user: { user_id: 'user-1', username: 'member', role: 'member' },
    });
    const refreshCreate = vi
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('network unavailable'), { code: 503 }))
      .mockResolvedValueOnce({
        accessToken: refreshedAccessToken,
        refreshToken: 'refresh-token-2',
        user: { user_id: 'user-1', username: 'member', role: 'member' },
      });
    vi.mocked(createRestClient).mockResolvedValue({
      authenticate,
      service: vi.fn(() => ({ create: refreshCreate })),
    } as never);

    const { result, unmount } = renderHook(() => useAuth());
    await waitFor(() => expect(result.current.authenticated).toBe(true));
    localStorage.setItem('disco-access-token', tokenExpiringAt(Date.now() - 1_000));

    await act(async () => {
      window.dispatchEvent(new Event('pageshow'));
    });
    await waitFor(() => expect(refreshCreate).toHaveBeenCalledTimes(1));
    expect(result.current.authenticated).toBe(true);

    await act(async () => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => expect(refreshCreate).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.accessToken).toBe(refreshedAccessToken));
    expect(result.current.authenticated).toBe(true);
    unmount();
  });
});
