export interface EntityRouteParams {
  sessionShortId?: string;
  branchShortId?: string;
  artifactShortId?: string;
}

/**
 * Entity routes carry an explicit user target. Generic board/root restore
 * behavior must not override them while URL→state resolution catches up.
 */
export function hasExplicitEntityRouteTarget(params: EntityRouteParams): boolean {
  return Boolean(params.sessionShortId || params.branchShortId || params.artifactShortId);
}

/** Route prefix owned by the settings modal — kept in step with
 *  `useSettingsRoute`, which parses and builds these paths. */
const SETTINGS_PATH_PREFIX = '/settings';

function isSettingsPath(pathname: string): boolean {
  return pathname === SETTINGS_PATH_PREFIX || pathname.startsWith(`${SETTINGS_PATH_PREFIX}/`);
}

/**
 * The path whose surface the workspace shell should render — Home vs. the
 * board canvas. Normally just the pathname.
 *
 * (Distinct from `RouteSurfaceId` in `surfaces/surfaceRegistry.ts`, which
 * picks between top-level route families such as Workspace and Knowledge.
 * This chooses between the shell's two interiors, one route family down.)
 *
 * Settings is the exception. It is a routed overlay: `/settings/...` owns
 * the address bar while the surface it was opened over stays mounted
 * behind the modal. `useSettingsRoute.openSettings` records that origin as
 * `settingsBackgroundPath` in history state, so read the surface from
 * there. Deriving it from the pathname makes every settings open look like
 * a navigation away from Home, swapping in the board canvas underneath
 * before the modal paints.
 *
 * Falls back to the pathname when no usable origin was recorded — a
 * settings URL opened cold (shared link, hard refresh) has no prior
 * surface to preserve.
 */
export function getShellSurfacePath(location: { pathname: string; state?: unknown }): string {
  if (!isSettingsPath(location.pathname)) return location.pathname;
  const background = (location.state as { settingsBackgroundPath?: unknown } | null)
    ?.settingsBackgroundPath;
  if (typeof background !== 'string' || !background.startsWith('/')) return location.pathname;
  // The recorded origin carries search + hash; only the path selects a surface.
  const backgroundPath = background.split('?')[0].split('#')[0] || '/';
  // Defensive: never resolve one settings route to another.
  return isSettingsPath(backgroundPath) ? location.pathname : backgroundPath;
}
