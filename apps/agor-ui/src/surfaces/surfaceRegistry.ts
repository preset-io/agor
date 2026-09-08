import { matchPath } from 'react-router-dom';
import { surfaceTitle } from '../branding/brand';

export type RouteSurfaceId =
  | 'workspace'
  | 'knowledge'
  | 'marketplace'
  | 'mcp-recovery'
  | 'artifact-fullscreen'
  | 'demo';

export interface RouteSurfaceDefinition {
  id: RouteSurfaceId;
  /** Human-readable label for docs/debugging. */
  label: string;
  /** React Router route patterns owned by this surface. */
  routePaths: readonly string[];
  /** Whether entering this surface should start the heavy Workspace store. */
  startsWorkspaceRuntime: boolean;
  /** Whether the mobile/desktop device redirect should run on this surface. */
  usesDeviceRouter: boolean;
  /** Whether user settings are owned by the shared shell instead of Workspace App. */
  usesSharedUserSettings: boolean;
  /**
   * Branding behavior for the browser tab (favicon + title).
   *
   * - `'dynamic'`: the surface manages the favicon/title itself at runtime
   *   (the Workspace shell rewrites the favicon with status dots via
   *   useFaviconStatus and sets the title from the active board). Exactly one
   *   surface may be dynamic.
   * - a string: a static document title applied via useSurfaceBranding, which
   *   also pins the favicon to the absolute brand mark so deep-linked nested
   *   routes don't fall back to the relative index.html href (which 404s).
   *
   * Build with surfaceTitle() so the wordmark/separator stay centralized. Every
   * surface MUST declare this so new surfaces can't silently inherit a broken
   * favicon — enforced by surfaceRegistry.test.ts.
   */
  branding: 'dynamic' | string;
}

const normalizePathname = (pathname: string): string =>
  pathname.startsWith('/') ? pathname : `/${pathname}`;

function routePathMatches(pathname: string, routePath: string): boolean {
  return matchPath({ path: routePath, end: true }, normalizePathname(pathname)) !== null;
}

function surfaceMatchesPath(surface: RouteSurfaceDefinition, pathname: string): boolean {
  return surface.routePaths.some((routePath) => routePathMatches(pathname, routePath));
}

function defineSurface(surface: RouteSurfaceDefinition): RouteSurfaceDefinition {
  return surface;
}

export const KNOWLEDGE_ROUTE_PATHS = [
  '/knowledge',
  '/knowledge/:namespaceSlug/*',
  '/kb',
  '/kb/:namespaceSlug/*',
] as const;

export const KNOWLEDGE_SURFACE = defineSurface({
  id: 'knowledge',
  label: 'Knowledge',
  routePaths: KNOWLEDGE_ROUTE_PATHS,
  startsWorkspaceRuntime: false,
  usesDeviceRouter: false,
  usesSharedUserSettings: true,
  branding: surfaceTitle('Knowledge'),
});

export const MARKETPLACE_ROUTE_PATHS = [
  '/marketplace',
  '/marketplace/catalog',
  '/marketplace/servers',
  '/marketplace/sessions',
  '/marketplace/credentials',
] as const;

export const MARKETPLACE_SURFACE = defineSurface({
  id: 'marketplace',
  label: 'Marketplace',
  routePaths: MARKETPLACE_ROUTE_PATHS,
  // Browsing the catalog reads the checked-in curated file the daemon serves
  // whole, not the tenant's boards and sessions, so the workspace store stays
  // cold until connect navigates into a session.
  startsWorkspaceRuntime: false,
  usesDeviceRouter: false,
  usesSharedUserSettings: true,
  branding: surfaceTitle('Marketplace'),
});

export const ARTIFACT_FULLSCREEN_ROUTE_PATHS = ['/a/:artifactShortId/fullscreen'] as const;

export const MCP_RECOVERY_ROUTE_PATHS = ['/recover/mcp'] as const;

export const MCP_RECOVERY_SURFACE = defineSurface({
  id: 'mcp-recovery',
  label: 'MCP recovery',
  routePaths: MCP_RECOVERY_ROUTE_PATHS,
  startsWorkspaceRuntime: false,
  usesDeviceRouter: false,
  usesSharedUserSettings: true,
  branding: surfaceTitle('MCP recovery'),
});

export const ARTIFACT_FULLSCREEN_SURFACE = defineSurface({
  id: 'artifact-fullscreen',
  label: 'Artifact fullscreen',
  routePaths: ARTIFACT_FULLSCREEN_ROUTE_PATHS,
  startsWorkspaceRuntime: false,
  usesDeviceRouter: false,
  usesSharedUserSettings: true,
  branding: surfaceTitle('Artifact'),
});

export const RBAC_POLICY_PROTOTYPE_ROUTE_PATH = '/demo/rbac-policy' as const;

/**
 * Development prototypes must never become production surfaces by accident.
 * Keeping route construction pure also lets tests prove the production path
 * list excludes the prototype even though Vitest itself runs in DEV mode.
 */
export function getDemoRoutePaths(includeDevelopmentPrototypes = import.meta.env.DEV): string[] {
  return [
    '/demo/streamdown',
    '/demo/marketing-screenshots',
    '/demo/marketing-video',
    ...(includeDevelopmentPrototypes ? [RBAC_POLICY_PROTOTYPE_ROUTE_PATH] : []),
  ];
}

export const DEMO_SURFACE = defineSurface({
  id: 'demo',
  label: 'Demo',
  routePaths: getDemoRoutePaths(),
  startsWorkspaceRuntime: false,
  usesDeviceRouter: false,
  usesSharedUserSettings: false,
  branding: surfaceTitle('Demo'),
});

export const WORKSPACE_SURFACE = defineSurface({
  id: 'workspace',
  label: 'Workspace',
  routePaths: ['/*'],
  startsWorkspaceRuntime: true,
  usesDeviceRouter: true,
  usesSharedUserSettings: false,
  // The Workspace shell drives favicon (status dots) and title (active board)
  // at runtime via useFaviconStatus / useBoardTitle.
  branding: 'dynamic',
});

export const SURFACE_REGISTRY = [
  KNOWLEDGE_SURFACE,
  MARKETPLACE_SURFACE,
  MCP_RECOVERY_SURFACE,
  ARTIFACT_FULLSCREEN_SURFACE,
  DEMO_SURFACE,
  WORKSPACE_SURFACE,
] as const;

export function getRouteSurface(pathname: string): RouteSurfaceDefinition {
  return (
    SURFACE_REGISTRY.find((surface) => surfaceMatchesPath(surface, pathname)) ?? WORKSPACE_SURFACE
  );
}

export function isKnowledgeRoutePath(pathname: string): boolean {
  return getRouteSurface(pathname).id === 'knowledge';
}

export function isWorkspaceRoutePath(pathname: string): boolean {
  return getRouteSurface(pathname).id === 'workspace';
}

export function routeStartsWorkspaceRuntime(pathname: string): boolean {
  return getRouteSurface(pathname).startsWorkspaceRuntime;
}

export function routeUsesDeviceRouter(pathname: string): boolean {
  return getRouteSurface(pathname).usesDeviceRouter;
}

export function routeUsesSharedUserSettings(pathname: string): boolean {
  return getRouteSurface(pathname).usesSharedUserSettings;
}
