export type RouteSurfaceId = 'workspace' | 'knowledge' | 'demo';

export interface RouteSurfaceDefinition {
  id: RouteSurfaceId;
  /** Human-readable label for docs/debugging. */
  label: string;
  /** React Router route patterns owned by this surface. */
  routePaths: readonly string[];
  /** Match URL pathnames at runtime before rendering the route tree. */
  matchesPath: (pathname: string) => boolean;
  /** Whether entering this surface should start the heavy Workspace store. */
  startsWorkspaceRuntime: boolean;
  /** Whether the mobile/desktop device redirect should run on this surface. */
  usesDeviceRouter: boolean;
  /** Whether user settings are owned by the shared shell instead of Workspace App. */
  usesSharedUserSettings: boolean;
}

const pathStartsWithSegment = (pathname: string, segment: string): boolean => {
  const normalized = pathname.startsWith('/') ? pathname : `/${pathname}`;
  return normalized === `/${segment}` || normalized.startsWith(`/${segment}/`);
};

export const KNOWLEDGE_ROUTE_PATHS = [
  '/knowledge',
  '/knowledge/:namespaceSlug/*',
  '/kb',
  '/kb/:namespaceSlug/*',
] as const;

export const SURFACE_REGISTRY = [
  {
    id: 'knowledge',
    label: 'Knowledge',
    routePaths: KNOWLEDGE_ROUTE_PATHS,
    matchesPath: (pathname: string) =>
      pathStartsWithSegment(pathname, 'kb') || pathStartsWithSegment(pathname, 'knowledge'),
    startsWorkspaceRuntime: false,
    usesDeviceRouter: false,
    usesSharedUserSettings: true,
  },
  {
    id: 'demo',
    label: 'Demo',
    routePaths: ['/demo/streamdown'],
    matchesPath: (pathname: string) => pathStartsWithSegment(pathname, 'demo'),
    startsWorkspaceRuntime: false,
    usesDeviceRouter: false,
    usesSharedUserSettings: false,
  },
  {
    id: 'workspace',
    label: 'Workspace',
    routePaths: ['/*'],
    matchesPath: () => true,
    startsWorkspaceRuntime: true,
    usesDeviceRouter: true,
    usesSharedUserSettings: false,
  },
] as const satisfies readonly RouteSurfaceDefinition[];

export function getRouteSurface(pathname: string): RouteSurfaceDefinition {
  return SURFACE_REGISTRY.find((surface) => surface.matchesPath(pathname)) ?? SURFACE_REGISTRY[2];
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
