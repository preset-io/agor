import { describe, expect, it } from 'vitest';
import {
  getRouteSurface,
  isKnowledgeRoutePath,
  isWorkspaceRoutePath,
  routeStartsWorkspaceRuntime,
  routeUsesDeviceRouter,
  routeUsesSharedUserSettings,
} from './surfaceRegistry';

describe('surface route registry', () => {
  it.each([
    '/kb',
    '/kb/',
    '/kb/global',
    '/kb/global/page.md',
    '/knowledge',
    '/knowledge/',
    '/knowledge/team',
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

  it.each(['/a/artifact/fullscreen'])('classifies %s as Artifact fullscreen', (path) => {
    expect(getRouteSurface(path).id).toBe('artifact-fullscreen');
    expect(isKnowledgeRoutePath(path)).toBe(false);
    expect(isWorkspaceRoutePath(path)).toBe(false);
    expect(routeStartsWorkspaceRuntime(path)).toBe(false);
    expect(routeUsesDeviceRouter(path)).toBe(false);
    expect(routeUsesSharedUserSettings(path)).toBe(true);
  });

  it('keeps the registered standalone demo route lightweight', () => {
    expect(getRouteSurface('/demo/streamdown').id).toBe('demo');
    expect(routeStartsWorkspaceRuntime('/demo/streamdown')).toBe(false);
    expect(routeUsesDeviceRouter('/demo/streamdown')).toBe(false);
    expect(routeUsesSharedUserSettings('/demo/streamdown')).toBe(false);
  });

  it.each([
    '/demo',
    '/demo/',
    '/demo/anything-else',
  ])('falls back to Workspace for unregistered demo path %s', (path) => {
    expect(getRouteSurface(path).id).toBe('workspace');
    expect(routeStartsWorkspaceRuntime(path)).toBe(true);
  });

  it('does not treat similarly prefixed paths as Knowledge', () => {
    expect(isKnowledgeRoutePath('/kbish')).toBe(false);
    expect(isKnowledgeRoutePath('/knowledge-base')).toBe(false);
  });
});
