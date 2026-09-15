import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearAuthenticatedUploadCache, useAuthenticatedUpload } from './useAuthenticatedUpload';

beforeEach(() => {
  let count = 0;
  vi.stubGlobal(
    'URL',
    Object.assign(URL, {
      createObjectURL: vi.fn(() => `blob:upload-${++count}`),
      revokeObjectURL: vi.fn(),
    })
  );
});
afterEach(() => {
  clearAuthenticatedUploadCache();
  vi.unstubAllGlobals();
});

describe('useAuthenticatedUpload', () => {
  it('does not fetch on mount or session remount, then shares explicitly requested content', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['file'])));
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useAuthenticatedUpload('upl_file'));
    expect(first.result.current.loading).toBe(false);
    first.unmount();
    const second = renderHook(() => useAuthenticatedUpload('upl_file'));
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await Promise.all([second.result.current.load(), second.result.current.load()]);
    });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(second.result.current.objectUrl).toBe('blob:upload-1');
  });

  it('allows an explicit retry immediately after a failure', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('', { status: 500 }))
      .mockResolvedValueOnce(new Response(new Blob(['retry'])));
    vi.stubGlobal('fetch', fetchMock);
    const hook = renderHook(() => useAuthenticatedUpload('upl_retry'));
    await act(async () => {
      await expect(hook.result.current.load()).rejects.toThrow();
    });
    expect(hook.result.current.unavailable).toBe(true);
    await act(async () => {
      await hook.result.current.load();
    });
    expect(hook.result.current.unavailable).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('invalidates in-flight content when the account cache is cleared', async () => {
    let finish!: (value: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          finish = resolve;
        })
    );
    vi.stubGlobal('fetch', fetchMock);
    const hook = renderHook(() => useAuthenticatedUpload('upl_logout'));
    let requested!: Promise<unknown>;
    act(() => {
      requested = hook.result.current.load().catch(() => null);
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    clearAuthenticatedUploadCache();
    await act(async () => {
      finish(new Response(new Blob(['secret'])));
      await requested;
    });
    expect(URL.createObjectURL).not.toHaveBeenCalled();
    expect(hook.result.current.objectUrl).toBeNull();
  });

  it('keeps thumbnail bytes separate from full content for the same reference', async () => {
    const fetchMock = vi.fn(async () => new Response(new Blob(['bytes'])));
    vi.stubGlobal('fetch', fetchMock);
    const thumb = renderHook(() =>
      useAuthenticatedUpload('upl_same', { variant: 'thumbnail', enabled: true })
    );
    const file = renderHook(() => useAuthenticatedUpload('upl_same'));
    await waitFor(() => expect(thumb.result.current.objectUrl).toBe('blob:upload-1'));
    expect(file.result.current.objectUrl).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    await act(async () => {
      await file.result.current.load();
    });
    expect(file.result.current.objectUrl).toBe('blob:upload-2');
  });
});
