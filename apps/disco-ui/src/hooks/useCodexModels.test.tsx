import type { CodexModelCatalog, DiscoClient } from '@disco-live/client';
import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { useCodexModels } from './useCodexModels';

const catalog = (id: string): CodexModelCatalog => ({
  source: 'dynamic',
  default: id,
  models: [{ id, displayName: id, hidden: false, isDefault: true }],
});
function clientWith(find: ReturnType<typeof vi.fn>) {
  const listeners: Record<string, () => void> = {};
  return {
    listeners,
    client: {
      service: () => ({ find }),
      on: (event: string, handler: () => void) => {
        listeners[event] = handler;
      },
    } as unknown as DiscoClient,
  };
}

it('shares discovery between selectors and retains a non-authoritative cache after failure', async () => {
  const find = vi
    .fn()
    .mockResolvedValueOnce(catalog('fresh'))
    .mockRejectedValue(new Error('offline'));
  const { client } = clientWith(find);
  const first = renderHook(() => useCodexModels(client));
  const second = renderHook(() => useCodexModels(client));
  await waitFor(() => expect(second.result.current.catalog.default).toBe('fresh'));
  expect(second.result.current.resolved).toBe(true);
  expect(find).toHaveBeenCalledOnce();
  let now = Date.now();
  vi.spyOn(Date, 'now').mockImplementation(() => now);
  now += 5 * 60_000 + 1;
  act(() => window.dispatchEvent(new Event('focus')));
  await waitFor(() => expect(second.result.current.catalog.source).toBe('cached'));
  expect(second.result.current.resolved).toBe(true);
  expect(second.result.current.catalog.default).toBe('fresh');
  first.unmount();
  second.unmount();
  vi.restoreAllMocks();
});

it('clears previous-user data on logout and ignores that user late response', async () => {
  let resolveOld!: (value: CodexModelCatalog) => void;
  const find = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<CodexModelCatalog>((resolve) => {
          resolveOld = resolve;
        })
    )
    .mockResolvedValue(catalog('user-b'));
  const { client, listeners } = clientWith(find);
  const hook = renderHook(() => useCodexModels(client));
  expect(hook.result.current.resolved).toBe(false);
  await waitFor(() => expect(find).toHaveBeenCalledOnce());
  act(() => {
    listeners.logout();
    listeners.authenticated();
  });
  await waitFor(() => expect(hook.result.current.catalog.default).toBe('user-b'));
  expect(hook.result.current.resolved).toBe(true);
  await act(async () => {
    resolveOld(catalog('user-a'));
  });
  expect(hook.result.current.catalog.default).toBe('user-b');
  hook.unmount();
});
