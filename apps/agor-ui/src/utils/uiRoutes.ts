import { resolveUiRuntime, routerBasenameForRuntime } from '../config/urlRuntime';

function currentPathname(): string {
  return typeof window === 'undefined' ? '/' : window.location.pathname;
}

export function getRouterBasename(
  baseUrl = import.meta.env.BASE_URL,
  pathname = currentPathname()
): string {
  return routerBasenameForRuntime(resolveUiRuntime({ baseUrl, pathname }));
}

export function uiRouteHref(path: string, baseUrl = import.meta.env.BASE_URL): string {
  return `${getRouterBasename(baseUrl)}${path.startsWith('/') ? path : `/${path}`}`;
}

type ResponsiveRouteEntities = {
  boards: Iterable<{ board_id: string; slug?: string }>;
  sessions: Iterable<{ session_id: string }>;
};

/** Preserve the selected board/session when crossing the mobile breakpoint. */
export function responsiveRoutePath(
  pathname: string,
  target: 'mobile' | 'desktop',
  entities: ResponsiveRouteEntities
): string {
  if (target === 'mobile') {
    const boardToken = pathname.match(/^\/b\/([^/]+)\/?$/)?.[1];
    if (boardToken) {
      const board = Array.from(entities.boards).find(
        (item) =>
          item.board_id === boardToken ||
          item.slug === boardToken ||
          item.board_id.startsWith(boardToken)
      );
      if (board) return `/m/board/${board.board_id}`;
    }
    const sessionToken = pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
    if (sessionToken) {
      const session = Array.from(entities.sessions).find(
        (item) => item.session_id === sessionToken || item.session_id.startsWith(sessionToken)
      );
      if (session) return `/m/session/${session.session_id}`;
    }
    return '/m';
  }

  const match = pathname.match(/^\/m\/(board|comments|session)\/([^/]+)\/?$/);
  if (!match) return '/';
  const [, kind, id] = match;
  if (kind === 'session') return `/s/${id.slice(0, 8)}/`;
  const board = Array.from(entities.boards).find((item) => item.board_id === id);
  return `/b/${board?.slug ?? id.slice(0, 8)}/`;
}
