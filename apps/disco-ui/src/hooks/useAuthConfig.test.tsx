import { renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useAuthConfig } from './useAuthConfig';

describe('useAuthConfig', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads only the local authentication requirement from health', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          status: 'ok',
          timestamp: Date.now(),
          version: 'test',
          database: 'sqlite',
          auth: {
            requireAuth: true,
            ignoredLegacyExternalLaunch: { enabled: true },
          },
        }),
      }))
    );

    const { result } = renderHook(() => useAuthConfig());

    await waitFor(() => expect(result.current.loading).toBe(false));

    expect(result.current.config).toEqual({ requireAuth: true });
  });
});
