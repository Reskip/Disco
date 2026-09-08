import { useEffect, useState } from 'react';
import { getRouteSurface } from './surfaceRegistry';

export interface WorkspaceSurfaceLifecycle {
  currentSurface: ReturnType<typeof getRouteSurface>;
  routeRequiresWorkspaceSurface: boolean;
  workspaceSurfaceStarted: boolean;
  workspaceSurfaceShouldRun: boolean;
}

/**
 * Sticky Workspace runtime lifecycle.
 *
 * Fresh lightweight-surface loads (marketplace, demos) should not hydrate the
 * heavy Workspace store. Once a user enters any Workspace route in this tab,
 * keep the store/socket subscriptions warm across later lightweight-surface
 * navigation so secondary links do not throw away workspace/session state.
 */
export function useWorkspaceSurfaceLifecycle(pathname: string): WorkspaceSurfaceLifecycle {
  const currentSurface = getRouteSurface(pathname);
  const routeRequiresWorkspaceSurface = currentSurface.startsWorkspaceRuntime;
  const [workspaceSurfaceStarted, setWorkspaceSurfaceStarted] = useState(
    routeRequiresWorkspaceSurface
  );

  useEffect(() => {
    if (routeRequiresWorkspaceSurface) setWorkspaceSurfaceStarted(true);
  }, [routeRequiresWorkspaceSurface]);

  return {
    currentSurface,
    routeRequiresWorkspaceSurface,
    workspaceSurfaceStarted,
    workspaceSurfaceShouldRun: routeRequiresWorkspaceSurface || workspaceSurfaceStarted,
  };
}
