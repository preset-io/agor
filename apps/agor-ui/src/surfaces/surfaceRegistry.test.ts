import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BRAND, surfaceTitle } from '../branding/brand';
import {
  CATALOG_ROUTE_PATHS,
  getDemoRoutePaths,
  getRouteSurface,
  isKnowledgeRoutePath,
  isWorkspaceRoutePath,
  routeStartsWorkspaceRuntime,
  routeUsesDeviceRouter,
  routeUsesSharedUserSettings,
  SURFACE_REGISTRY,
} from './surfaceRegistry';

describe('surface route registry', () => {
  it('registers only the four canonical Catalog routes', () => {
    expect(CATALOG_ROUTE_PATHS).toEqual([
      '/catalog',
      '/catalog/servers',
      '/catalog/sessions',
      '/catalog/credentials',
    ]);
  });

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

  it.each(['/', '/b/board/', '/s/session/', '/w/branch/', '/a/artifact/', '/m'])(
    'classifies %s as Workspace',
    (path) => {
      expect(getRouteSurface(path).id).toBe('workspace');
      expect(isKnowledgeRoutePath(path)).toBe(false);
      expect(isWorkspaceRoutePath(path)).toBe(true);
      expect(routeStartsWorkspaceRuntime(path)).toBe(true);
      expect(routeUsesDeviceRouter(path)).toBe(true);
      expect(routeUsesSharedUserSettings(path)).toBe(false);
    }
  );

  it.each(['/catalog', '/catalog/servers', '/catalog/sessions', '/catalog/credentials'])(
    'classifies canonical %s as Catalog',
    (path) => {
      expect(getRouteSurface(path).id).toBe('catalog');
      expect(isWorkspaceRoutePath(path)).toBe(false);
      expect(routeStartsWorkspaceRuntime(path)).toBe(false);
      expect(routeUsesDeviceRouter(path)).toBe(false);
      expect(routeUsesSharedUserSettings(path)).toBe(true);
    }
  );

  it.each([
    '/marketplace',
    '/marketplace/catalog',
    '/marketplace/servers',
    '/marketplace/sessions',
    '/marketplace/credentials',
  ])('does not register removed Marketplace route %s as Catalog', (path) => {
    expect(CATALOG_ROUTE_PATHS).not.toContain(path);
    expect(getRouteSurface(path).id).toBe('workspace');
  });

  it.each(['/catalogs', '/catalog/extra', '/marketplaces', '/marketplace/extra'])(
    'does not treat unsupported Catalog-like path %s as Catalog',
    (path) => {
      expect(getRouteSurface(path).id).toBe('workspace');
    }
  );

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

  it('excludes the RBAC prototype from production demo route registration', () => {
    expect(getDemoRoutePaths(false)).not.toContain('/demo/rbac-policy');
    expect(getDemoRoutePaths(true)).toContain('/demo/rbac-policy');
  });

  it.each(['/demo', '/demo/', '/demo/anything-else'])(
    'falls back to Workspace for unregistered demo path %s',
    (path) => {
      expect(getRouteSurface(path).id).toBe('workspace');
      expect(routeStartsWorkspaceRuntime(path)).toBe(true);
    }
  );

  it('does not treat similarly prefixed paths as Knowledge', () => {
    expect(isKnowledgeRoutePath('/kbish')).toBe(false);
    expect(isKnowledgeRoutePath('/knowledge-base')).toBe(false);
  });
});

describe('surface branding declarations', () => {
  it('names and brands the product surface as Catalog', () => {
    const catalog = SURFACE_REGISTRY.find((surface) => surface.id === 'catalog');
    expect(catalog?.label).toBe('Catalog');
    expect(catalog?.branding).toBe(surfaceTitle('Catalog'));
  });

  it('every surface declares branding (favicon + title) behavior', () => {
    // Forces a new surface to opt into the shared branding contract instead of
    // silently inheriting the static index.html favicon/title.
    for (const surface of SURFACE_REGISTRY) {
      expect(surface.branding, `surface "${surface.id}" must declare branding`).toBeTruthy();
    }
  });

  it('exactly one surface manages favicon/title dynamically (the Workspace shell)', () => {
    const dynamic = SURFACE_REGISTRY.filter((s) => s.branding === 'dynamic');
    expect(dynamic.map((s) => s.id)).toEqual(['workspace']);
  });

  it('static-branding surfaces use the centralized title format', () => {
    for (const surface of SURFACE_REGISTRY) {
      if (surface.branding === 'dynamic') continue;
      // Must be a surfaceTitle()-shaped string ending in the brand wordmark, so
      // titles can't drift in separator/casing across surfaces.
      const label = surface.branding.split(BRAND.titleSeparator)[0];
      expect(surface.branding).toBe(surfaceTitle(label));
      expect(surface.branding.endsWith(BRAND.name)).toBe(true);
    }
  });
});

describe('index.html favicon', () => {
  it('references the backed badge with a root-absolute href (Vite rebases to the base)', () => {
    // vitest runs with cwd at the package root, where index.html lives.
    const html = readFileSync(path.resolve(process.cwd(), 'index.html'), 'utf8');
    const iconMatch = html.match(/<link[^>]*rel=["']icon["'][^>]*>/i);
    expect(iconMatch, 'index.html must declare a <link rel="icon">').not.toBeNull();

    const href = iconMatch?.[0].match(/href=["']([^"']+)["']/i)?.[1] ?? '';
    const type = iconMatch?.[0].match(/type=["']([^"']+)["']/i)?.[1] ?? '';
    // Root-absolute only. A relative href (e.g. "logo.svg") 404s on nested
    // SPA deep-links — exactly the Knowledge-surface favicon bug.
    expect(href.startsWith('/')).toBe(true);
    expect(href.endsWith(BRAND.badgeFile)).toBe(true);
    expect(type).toBe('image/svg+xml');
  });
});
