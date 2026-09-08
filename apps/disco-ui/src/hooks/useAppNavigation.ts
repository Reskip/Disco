import { sessionPath, type SessionID } from '@disco-live/client';
import { useCallback, useMemo, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';

export interface NavigationOpts {
  replace?: boolean;
}

export interface AppNavigation {
  goToSession: (sessionId: string, opts?: NavigationOpts) => void;
  goHome: (opts?: NavigationOpts) => void;
}

function canonical(path: string): string {
  return `${path.replace(/\/$/u, '')}/`;
}

/** Navigation for the conversation-only product surface. */
export function useAppNavigation(): AppNavigation {
  const navigate = useNavigate();
  const location = useLocation();
  const locationPathnameRef = useRef(location.pathname);
  locationPathnameRef.current = location.pathname;

  const pushPath = useCallback(
    (target: string, opts?: NavigationOpts) => {
      if (canonical(target) === canonical(locationPathnameRef.current)) return;
      navigate(target, { replace: opts?.replace ?? false });
    },
    [navigate]
  );

  const goToSession = useCallback(
    (sessionId: string, opts?: NavigationOpts) => pushPath(sessionPath(sessionId as SessionID), opts),
    [pushPath]
  );
  const goHome = useCallback((opts?: NavigationOpts) => pushPath('/', opts), [pushPath]);

  return useMemo(() => ({ goToSession, goHome }), [goHome, goToSession]);
}
