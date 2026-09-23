import { type BoardID, boardPath, type SessionID, sessionPath } from '@agor-live/client';
import { resolveUiRuntime, routerBasenameForRuntime } from '../config/urlRuntime';
import { resolveBoardFromUrlPure, resolveSessionFromShortIdPure } from './urlResolution';

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
      const boards = new Map(Array.from(entities.boards, (board) => [board.board_id, board]));
      const boardId = resolveBoardFromUrlPure(boardToken, boards);
      // Keep a cold slug/short-id deep link intact. Mobile board resolution uses
      // the same ambiguity-safe resolver once the initial board list arrives.
      return `/m/board/${boardId ?? boardToken}`;
    }
    const sessionToken = pathname.match(/^\/s\/([^/]+)\/?$/)?.[1];
    if (sessionToken) {
      const sessions = new Map(
        Array.from(entities.sessions, (session) => [session.session_id, session])
      );
      const sessionId = resolveSessionFromShortIdPure(sessionToken, sessions);
      // The loader accepts short IDs, so preserve a cold canonical token rather
      // than discarding navigation context while the store is still empty.
      return `/m/session/${sessionId ?? sessionToken}`;
    }
    return '/m';
  }

  // The desktop MCP catalog and global search are modals, not routes, so carry
  // the intent as a query flag the workspace opens on arrival — otherwise a
  // resize off these tabs silently dumps the user on a bare desktop Home.
  if (/^\/m\/marketplace\/?$/.test(pathname)) return '/?open=mcp-catalog';
  if (/^\/m\/search\/?$/.test(pathname)) return '/?open=search';

  const match = pathname.match(/^\/m\/(board|comments|session)\/([^/]+)\/?$/);
  if (!match) return '/';
  const [, kind, id] = match;
  // Build the desktop targets with the same helpers the rest of the app uses, so
  // the short-id form here can't drift from what `useUrlState` resolves.
  if (kind === 'session') return sessionPath(id as SessionID);
  const board = Array.from(entities.boards).find((item) => item.board_id === id);
  return boardPath(id as BoardID, board?.slug);
}
