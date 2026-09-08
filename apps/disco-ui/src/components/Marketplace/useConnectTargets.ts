/** Existing sessions a catalog server can be attached to. */

import type { Session } from '@disco/core/types';
import type { DiscoClient } from '@disco-live/client';
import { useEffect, useState } from 'react';

const LAST_SESSION_KEY = 'disco-marketplace-session';

export interface ConnectTargets {
  sessions: Session[];
  loading: boolean;
  error: string | null;
}

export function useConnectTargets(client: DiscoClient | null, enabled: boolean): ConnectTargets {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!client || !enabled || loaded) return;
    let cancelled = false;
    setLoading(true);
    client
      .service('sessions')
      .findAll({ query: { archived: false, $sort: { last_updated: -1 } } })
      .then((result) => {
        if (cancelled) return;
        setSessions(result);
        setError(null);
        setLoaded(true);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Could not load your sessions');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client, enabled, loaded]);

  return { sessions, loading, error };
}

export function getLastConnectSessionId(): string | null {
  try {
    return localStorage.getItem(LAST_SESSION_KEY);
  } catch {
    return null;
  }
}

export function rememberConnectSessionId(sessionId: string): void {
  try {
    localStorage.setItem(LAST_SESSION_KEY, sessionId);
  } catch {
    // localStorage unavailable
  }
}
