import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useWorkspaceSurfaceLifecycle } from './useWorkspaceSurfaceLifecycle';

describe('useWorkspaceSurfaceLifecycle', () => {
  it('does not start Workspace runtime on a fresh marketplace route', () => {
    const { result } = renderHook(({ pathname }) => useWorkspaceSurfaceLifecycle(pathname), {
      initialProps: { pathname: '/marketplace' },
    });

    expect(result.current.currentSurface.id).toBe('marketplace');
    expect(result.current.routeRequiresWorkspaceSurface).toBe(false);
    expect(result.current.workspaceSurfaceStarted).toBe(false);
    expect(result.current.workspaceSurfaceShouldRun).toBe(false);
  });

  it('keeps Workspace runtime warm after internal navigation to marketplace', () => {
    const { result, rerender } = renderHook(
      ({ pathname }) => useWorkspaceSurfaceLifecycle(pathname),
      { initialProps: { pathname: '/b/main-board/' } }
    );

    expect(result.current.currentSurface.id).toBe('workspace');
    expect(result.current.workspaceSurfaceShouldRun).toBe(true);

    rerender({ pathname: '/marketplace' });

    expect(result.current.currentSurface.id).toBe('marketplace');
    expect(result.current.routeRequiresWorkspaceSurface).toBe(false);
    expect(result.current.workspaceSurfaceStarted).toBe(true);
    expect(result.current.workspaceSurfaceShouldRun).toBe(true);
  });

  it('starts Workspace runtime when leaving a lightweight surface for Workspace', () => {
    const { result, rerender } = renderHook(
      ({ pathname }) => useWorkspaceSurfaceLifecycle(pathname),
      { initialProps: { pathname: '/marketplace' } }
    );

    expect(result.current.workspaceSurfaceShouldRun).toBe(false);

    rerender({ pathname: '/s/session-id/' });

    expect(result.current.currentSurface.id).toBe('workspace');
    expect(result.current.routeRequiresWorkspaceSurface).toBe(true);
    expect(result.current.workspaceSurfaceShouldRun).toBe(true);
  });
});
