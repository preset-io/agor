import { describe, expect, it } from 'vitest';
import {
  getRouteSurface,
  isKnowledgeRoutePath,
  isWorkspaceRoutePath,
  routeStartsWorkspaceRuntime,
  routeUsesDeviceRouter,
  routeUsesSharedUserSettings,
} from './surfaceRoutes';

describe('surface route classifiers', () => {
  it.each([
    '/kb',
    '/kb/',
    '/kb/global/page.md',
    '/knowledge',
    '/knowledge/team/docs',
  ])('classifies %s as Knowledge', (path) => {
    expect(getRouteSurface(path).id).toBe('knowledge');
    expect(isKnowledgeRoutePath(path)).toBe(true);
    expect(isWorkspaceRoutePath(path)).toBe(false);
    expect(routeStartsWorkspaceRuntime(path)).toBe(false);
    expect(routeUsesDeviceRouter(path)).toBe(false);
    expect(routeUsesSharedUserSettings(path)).toBe(true);
  });

  it.each([
    '/',
    '/b/board/',
    '/s/session/',
    '/w/branch/',
    '/a/artifact/',
    '/m',
  ])('classifies %s as Workspace', (path) => {
    expect(getRouteSurface(path).id).toBe('workspace');
    expect(isKnowledgeRoutePath(path)).toBe(false);
    expect(isWorkspaceRoutePath(path)).toBe(true);
    expect(routeStartsWorkspaceRuntime(path)).toBe(true);
    expect(routeUsesDeviceRouter(path)).toBe(true);
    expect(routeUsesSharedUserSettings(path)).toBe(false);
  });

  it('keeps standalone demo routes lightweight', () => {
    expect(getRouteSurface('/demo/streamdown').id).toBe('demo');
    expect(routeStartsWorkspaceRuntime('/demo/streamdown')).toBe(false);
    expect(routeUsesDeviceRouter('/demo/streamdown')).toBe(false);
    expect(routeUsesSharedUserSettings('/demo/streamdown')).toBe(false);
  });

  it('does not treat similarly prefixed paths as Knowledge', () => {
    expect(isKnowledgeRoutePath('/kbish')).toBe(false);
    expect(isKnowledgeRoutePath('/knowledge-base')).toBe(false);
  });
});
