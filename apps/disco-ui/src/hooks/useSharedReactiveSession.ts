import {
  type DiscoClient,
  type ReactiveSessionHandle,
  type ReactiveSessionOptions,
  type ReactiveSessionState,
  releaseReactiveSession,
  retainReactiveSession,
} from '@disco-live/client';
import { useEffect, useState } from 'react';
import { TOKENS_REFRESHED_EVENT } from '../utils/singleFlightRefresh';

interface UseSharedReactiveSessionOptions {
  enabled?: boolean;
  reactiveOptions?: ReactiveSessionOptions;
}

interface UseSharedReactiveSessionResult {
  handle: ReactiveSessionHandle | null;
  state: ReactiveSessionState | null;
}

export function useSharedReactiveSession(
  client: DiscoClient | null,
  sessionId: string | null | undefined,
  options: UseSharedReactiveSessionOptions = {}
): UseSharedReactiveSessionResult {
  const { enabled = true, reactiveOptions } = options;
  const taskHydration = reactiveOptions?.taskHydration ?? 'lazy';
  const messageView = reactiveOptions?.messageView ?? 'full';
  const [handle, setHandle] = useState<ReactiveSessionHandle | null>(null);
  const [state, setState] = useState<ReactiveSessionState | null>(null);

  useEffect(() => {
    if (!client || !sessionId || !enabled) {
      setHandle(null);
      setState(null);
      return;
    }

    const sharedHandle = retainReactiveSession(client, sessionId, { taskHydration, messageView });
    setHandle(sharedHandle);
    let disposed = false;

    const sync = () => {
      if (!disposed) {
        setState(sharedHandle.state);
      }
    };

    sync();
    const unsubscribe = sharedHandle.subscribe(sync);
    sharedHandle.ready().then(sync).catch(sync);

    return () => {
      disposed = true;
      unsubscribe();
      releaseReactiveSession(client, sessionId, { taskHydration, messageView });
    };
  }, [client, sessionId, enabled, taskHydration, messageView]);

  // A suspended browser can miss events without reporting an error. Catch up
  // the mounted session on foreground and after socket authentication, even
  // when its cached state looks healthy. resync() preserves existing content
  // and coalesces concurrent requests; deleted/inaccessible sessions stay put.
  useEffect(() => {
    if (!handle || !client) return;

    const tryResync = () => {
      const s = handle.state;
      if (document.visibilityState === 'hidden' || !client.io.connected || s.loading || s.terminal)
        return;
      void handle.resync();
    };

    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') tryResync();
    };
    const onTokensRefreshed = () => {
      tryResync();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pageshow', tryResync);
    window.addEventListener(TOKENS_REFRESHED_EVENT, onTokensRefreshed);
    client.on('authenticated', tryResync);

    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      window.removeEventListener('pageshow', tryResync);
      window.removeEventListener(TOKENS_REFRESHED_EVENT, onTokensRefreshed);
      client.off('authenticated', tryResync);
    };
  }, [handle, client]);

  return { handle, state };
}
