import { createRestClient } from '@disco-live/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { refreshMock } = vi.hoisted(() => ({ refreshMock: vi.fn() }));

vi.mock('@disco-live/client', async importOriginal => ({
  ...(await importOriginal<typeof import('@disco-live/client')>()),
  createRestClient: vi.fn(),
}));

vi.mock('./singleFlightRefresh', async importOriginal => ({
  ...(await importOriginal<typeof import('./singleFlightRefresh')>()),
  refreshTokensSingleFlight: refreshMock,
}));

import { authenticatedFetch, getFreshAccessToken } from './authenticatedFetch';
import { storeTokens } from './tokenRefresh';

function tokenExpiringAt(expMs: number): string {
  const payload = btoa(JSON.stringify({ exp: Math.floor(expMs / 1000) }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
  return `e30.${payload}.signature`;
}

function response(status: number): Response {
  return { status } as Response;
}

beforeEach(() => {
  localStorage.clear();
  refreshMock.mockReset();
  vi.mocked(createRestClient).mockReset();
  vi.mocked(createRestClient).mockResolvedValue({} as never);
  vi.stubGlobal('fetch', vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('getFreshAccessToken', () => {
  it('uses a stored access token that is not near expiry', async () => {
    const accessToken = tokenExpiringAt(Date.now() + 10 * 60_000);
    storeTokens(accessToken, 'refresh-token');

    await expect(getFreshAccessToken({ daemonUrl: 'https://disco.test' })).resolves.toBe(
      accessToken
    );
    expect(refreshMock).not.toHaveBeenCalled();
  });

  it('refreshes an expired token before a protected request starts', async () => {
    storeTokens(tokenExpiringAt(Date.now() - 1_000), 'refresh-token');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access' });

    await expect(getFreshAccessToken({ daemonUrl: 'https://disco.test' })).resolves.toBe(
      'fresh-access'
    );
    expect(createRestClient).toHaveBeenCalledWith('https://disco.test');
    expect(refreshMock).toHaveBeenCalledWith(expect.anything(), 'refresh-token');
  });

  it('falls back to a still-valid token when proactive refresh fails transiently', async () => {
    const accessToken = tokenExpiringAt(Date.now() + 30_000);
    storeTokens(accessToken, 'refresh-token');
    refreshMock.mockRejectedValue(Object.assign(new Error('temporary outage'), { code: 503 }));

    await expect(getFreshAccessToken()).resolves.toBe(accessToken);
  });
});

describe('authenticatedFetch', () => {
  it('replays a 401 once with the refreshed access token', async () => {
    const oldAccessToken = tokenExpiringAt(Date.now() + 10 * 60_000);
    storeTokens(oldAccessToken, 'refresh-token');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access' });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockResolvedValueOnce(response(401)).mockResolvedValueOnce(response(200));

    const result = await authenticatedFetch('https://disco.test/protected', undefined, {
      daemonUrl: 'https://disco.test',
    });

    expect(result.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(new Headers(fetchMock.mock.calls[0][1]?.headers).get('Authorization')).toBe(
      `Bearer ${oldAccessToken}`
    );
    expect(new Headers(fetchMock.mock.calls[1][1]?.headers).get('Authorization')).toBe(
      'Bearer fresh-access'
    );
    expect(refreshMock).toHaveBeenCalledTimes(1);
  });

  it('never returns the server raw jwt-expired response after the retry also returns 401', async () => {
    storeTokens(tokenExpiringAt(Date.now() + 10 * 60_000), 'refresh-token');
    refreshMock.mockResolvedValue({ accessToken: 'fresh-access' });
    vi.mocked(fetch).mockResolvedValue(response(401));

    await expect(authenticatedFetch('https://disco.test/protected')).rejects.toThrow(
      '登录状态已过期，请重新登录。'
    );
  });
});
