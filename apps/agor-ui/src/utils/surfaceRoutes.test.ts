import { describe, expect, it } from 'vitest';
import { isKnowledgeRoutePath, isWorkspaceRoutePath } from './surfaceRoutes';

describe('surface route classifiers', () => {
  it.each([
    '/kb',
    '/kb/',
    '/kb/global/page.md',
    '/knowledge',
    '/knowledge/team/docs',
  ])('classifies %s as Knowledge', (path) => {
    expect(isKnowledgeRoutePath(path)).toBe(true);
    expect(isWorkspaceRoutePath(path)).toBe(false);
  });

  it.each([
    '/',
    '/b/board/',
    '/s/session/',
    '/w/branch/',
    '/a/artifact/',
    '/m',
    '/demo/streamdown',
  ])('classifies %s as Workspace', (path) => {
    expect(isKnowledgeRoutePath(path)).toBe(false);
    expect(isWorkspaceRoutePath(path)).toBe(true);
  });

  it('does not treat similarly prefixed paths as Knowledge', () => {
    expect(isKnowledgeRoutePath('/kbish')).toBe(false);
    expect(isKnowledgeRoutePath('/knowledge-base')).toBe(false);
  });
});
