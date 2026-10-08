import type { DiscoClient, ReactiveSessionHandle } from '@disco-live/client';
import { retainReactiveSession } from '@disco-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSharedReactiveSession } from './useSharedReactiveSession';

vi.mock('@disco-live/client', async (original) => ({
  ...(await original<typeof import('@disco-live/client')>()),
  retainReactiveSession: vi.fn(),
  releaseReactiveSession: vi.fn(),
}));

const originalVisibility = Object.getOwnPropertyDescriptor(document, 'visibilityState');
afterEach(() => {
  vi.clearAllMocks();
  if (originalVisibility) Object.defineProperty(document, 'visibilityState', originalVisibility);
  else Reflect.deleteProperty(document, 'visibilityState');
});

function seam() {
  const callbacks = new Map<string, () => void>();
  const client = {
    io: { connected: true },
    on: vi.fn((event: string, callback: () => void) => callbacks.set(event, callback)),
    off: vi.fn((event: string) => callbacks.delete(event)),
  };
  const handle = {
    state: { loading: false, error: null, terminal: false },
    ready: vi.fn().mockResolvedValue(undefined),
    subscribe: vi.fn(() => vi.fn()),
    resync: vi.fn().mockResolvedValue(undefined),
  };
  vi.mocked(retainReactiveSession).mockReturnValue(handle as unknown as ReactiveSessionHandle);
  return { client, handle, callbacks };
}

describe('useSharedReactiveSession foreground recovery', () => {
  it('catches up silently missed events even if the cached session has no error', async () => {
    const { client, handle } = seam();
    const { unmount } = renderHook(() =>
      useSharedReactiveSession(client as unknown as DiscoClient, 'session')
    );
    await waitFor(() => expect(handle.subscribe).toHaveBeenCalled());
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(handle.resync).not.toHaveBeenCalled();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    act(() => document.dispatchEvent(new Event('visibilitychange')));
    expect(handle.resync).toHaveBeenCalledTimes(1);
    unmount();
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(handle.resync).toHaveBeenCalledTimes(1);
  });

  it('waits for authentication when wake happens while disconnected and skips terminal sessions', async () => {
    const { client, handle, callbacks } = seam();
    const { unmount } = renderHook(() =>
      useSharedReactiveSession(client as unknown as DiscoClient, 'session')
    );
    await waitFor(() => expect(handle.subscribe).toHaveBeenCalled());
    client.io.connected = false;
    act(() => window.dispatchEvent(new Event('pageshow')));
    expect(handle.resync).not.toHaveBeenCalled();
    client.io.connected = true;
    act(() => callbacks.get('authenticated')?.());
    expect(handle.resync).toHaveBeenCalledTimes(1);
    handle.state.terminal = true;
    act(() => {
      window.dispatchEvent(new Event('pageshow'));
      callbacks.get('authenticated')?.();
    });
    expect(handle.resync).toHaveBeenCalledTimes(1);
    unmount();
    expect(callbacks.has('authenticated')).toBe(false);
  });
});
