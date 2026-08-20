import { type BoardID, boardPath, type SessionID, sessionPath } from '@agor-live/client';
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
  // Build the desktop targets with the same helpers the rest of the app uses, so
  // the short-id form here can't drift from what `useUrlState` resolves.
  if (kind === 'session') return sessionPath(id as SessionID);
  const board = Array.from(entities.boards).find((item) => item.board_id === id);
  return boardPath(id as BoardID, board?.slug);
}
