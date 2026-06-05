import { renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useWorkspaceSurfaceLifecycle } from './useWorkspaceSurfaceLifecycle';

describe('useWorkspaceSurfaceLifecycle', () => {
  it('does not start Workspace runtime on fresh Knowledge deep links', () => {
    const { result } = renderHook(({ pathname }) => useWorkspaceSurfaceLifecycle(pathname), {
      initialProps: { pathname: '/kb/global/readme.md' },
    });

    expect(result.current.currentSurface.id).toBe('knowledge');
    expect(result.current.routeRequiresWorkspaceSurface).toBe(false);
    expect(result.current.workspaceSurfaceStarted).toBe(false);
    expect(result.current.workspaceSurfaceShouldRun).toBe(false);
  });

  it('keeps Workspace runtime warm after internal navigation to Knowledge', () => {
    const { result, rerender } = renderHook(
      ({ pathname }) => useWorkspaceSurfaceLifecycle(pathname),
      { initialProps: { pathname: '/b/main-board/' } }
    );

    expect(result.current.currentSurface.id).toBe('workspace');
    expect(result.current.workspaceSurfaceShouldRun).toBe(true);

    rerender({ pathname: '/knowledge/global/architecture.md' });

    expect(result.current.currentSurface.id).toBe('knowledge');
    expect(result.current.routeRequiresWorkspaceSurface).toBe(false);
    expect(result.current.workspaceSurfaceStarted).toBe(true);
    expect(result.current.workspaceSurfaceShouldRun).toBe(true);
  });

  it('starts Workspace runtime when leaving a lightweight surface for Workspace', () => {
    const { result, rerender } = renderHook(
      ({ pathname }) => useWorkspaceSurfaceLifecycle(pathname),
      { initialProps: { pathname: '/kb/global/readme.md' } }
    );

    expect(result.current.workspaceSurfaceShouldRun).toBe(false);

    rerender({ pathname: '/s/session-id/' });

    expect(result.current.currentSurface.id).toBe('workspace');
    expect(result.current.routeRequiresWorkspaceSurface).toBe(true);
    expect(result.current.workspaceSurfaceShouldRun).toBe(true);
  });
});
