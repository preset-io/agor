/**
 * URL & path utilities
 *
 * Single source of truth for:
 *   1. The path shape rendered by the UI router and consumed by share
 *      links — top-level entity paths (`/b/<board>/`, `/s/<sessionShort>/`,
 *      `/w/<worktreeShort>/`, `/a/<artifactShort>/`).
 *   2. The UI mount point (`/ui`) at which the daemon serves the SPA.
 *   3. Composition of full external URLs (`baseUrl + UI_MOUNT_PATH +
 *      path`) handed back through REST / MCP responses.
 *
 * Design note — flat entity URLs: sub-entities (sessions, worktrees,
 * artifacts) used to be nested under their board (`/b/<board>/w/<wt>/`).
 * Boards can move, so embedding the board in the URL of an object
 * that's only implicitly on it makes shared links rot when the object
 * moves. The new scheme uses the short ID as a stable entity identifier
 * — the app resolves the entity, looks up its current board, switches
 * if needed. Boards keep their `/b/<board>/` URL because they're a
 * destination in their own right.
 *
 * Server callers want full URLs (`getXUrl`); the UI router uses the
 * `xPath` builders directly (react-router adds `UI_MOUNT_PATH` via the
 * BrowserRouter `basename`, so the relative path is what we push).
 *
 * Also exports `normalizeOptionalHttpUrl` / `isAllowedHealthCheckUrl`
 * for unrelated user-input validation (kept here for historical reasons).
 */

// Import `shortId` directly from `types/id` (not `lib/ids`). `lib/ids`
// re-exports `shortId` for Node consumers but also imports
// `node:crypto` for `generateId()`. Going through it pulls a Node-only
// dependency into the browser bundle, which Vite externalizes and
// errors on at runtime (`crypto.randomBytes` not in browser scope).
import type { ArtifactID, BoardID, SessionID, WorktreeID } from '../types/id';
import { shortId } from '../types/id';

// ---------------------------------------------------------------------------
// Constants — shared by daemon static-serving, UI router basename, and the
// server-side URL builders below. Keep these in one place; the daemon and
// UI both import them rather than hardcoding.
// ---------------------------------------------------------------------------

/**
 * Path prefix under which the bundled UI is served (see
 * `apps/agor-daemon/src/index.ts` static-serving block). React Router
 * uses this as `BrowserRouter basename`, so client-side path builders
 * intentionally do NOT include it — the router prepends it on navigate.
 * Server-side `getXUrl` helpers DO include it because they're building
 * fully-qualified browser URLs.
 */
export const UI_MOUNT_PATH = '/ui';

/**
 * Top-level URL segments per entity type. Each addressable entity gets
 * one path-leading discriminator: `/b/...` for boards, `/s/...` for
 * sessions, etc. Keep this in lockstep with the route table in
 * `apps/agor-ui/src/App.tsx`.
 */
export const ENTITY_PATH_SEGMENTS = {
  board: 'b',
  session: 's',
  worktree: 'w',
  artifact: 'a',
} as const;

// ---------------------------------------------------------------------------
// Path builders — produce the `/<entity>/<id>/` shape with no `/ui`
// prefix and no base URL. Used by both the UI router (which adds `/ui`
// via basename) and the server-side URL builders (which add baseUrl +
// UI_MOUNT_PATH).
// ---------------------------------------------------------------------------

/** `/b/<board>/` — board view. Prefers the human-readable slug, falls
 *  back to the canonical short ID. */
export function boardPath(boardId: BoardID, boardSlug?: string | null): string {
  return `/${ENTITY_PATH_SEGMENTS.board}/${boardSlug || shortId(boardId)}/`;
}

/** `/s/<sessionShort>/` — session deep link. App resolves the session,
 *  switches to its worktree's board, and opens the conversation panel. */
export function sessionPath(sessionId: SessionID): string {
  return `/${ENTITY_PATH_SEGMENTS.session}/${shortId(sessionId)}/`;
}

/** `/w/<worktreeShort>/` — worktree deep link. App resolves the
 *  worktree, switches to its board, and recenters the canvas on its card. */
export function worktreePath(worktreeId: WorktreeID): string {
  return `/${ENTITY_PATH_SEGMENTS.worktree}/${shortId(worktreeId)}/`;
}

/** `/a/<artifactShort>/` — artifact deep link. Same shape as worktree. */
export function artifactPath(artifactId: ArtifactID): string {
  return `/${ENTITY_PATH_SEGMENTS.artifact}/${shortId(artifactId)}/`;
}

// ---------------------------------------------------------------------------
// Full URL builders — `baseUrl + UI_MOUNT_PATH + path()`. Used by
// repositories to populate the `url` field on entities returned through
// REST / socket / MCP.
// ---------------------------------------------------------------------------

/** Compose a full external URL from a relative entity path.
 *  Strips a trailing slash off `baseUrl` defensively so misconfigured
 *  `daemon.base_url` values (e.g. `https://agor.example.com/`) don't
 *  produce double-slashed URLs like `https://agor.example.com//ui/...`.
 *  `baseUrl` here comes from `getBaseUrl()` in config-manager, which
 *  reads `daemon.base_url` (with an `AGOR_BASE_URL` env override). */
function fullUrl(path: string, baseUrl: string): string {
  return `${baseUrl.replace(/\/$/, '')}${UI_MOUNT_PATH}${path}`;
}

/** Generate a board URL. */
export function getBoardUrl(
  boardId: BoardID,
  boardSlug: string | null | undefined,
  baseUrl: string
): string {
  return fullUrl(boardPath(boardId, boardSlug), baseUrl);
}

/** Generate a session URL. Always returns a URL — the entity resolves
 *  to its board at click time. */
export function getSessionUrl(sessionId: SessionID, baseUrl: string): string {
  return fullUrl(sessionPath(sessionId), baseUrl);
}

/** Generate a worktree URL. Always returns a URL — the entity resolves
 *  to its board at click time. */
export function getWorktreeUrl(worktreeId: WorktreeID, baseUrl: string): string {
  return fullUrl(worktreePath(worktreeId), baseUrl);
}

/** Generate an artifact URL. Always returns a URL — the entity
 *  resolves to its board at click time. */
export function getArtifactUrl(artifactId: ArtifactID, baseUrl: string): string {
  return fullUrl(artifactPath(artifactId), baseUrl);
}

// ---------------------------------------------------------------------------
// Unrelated user-input validation helpers — kept here for historical
// reasons. Used by worktree issue_url / pull_request_url normalization
// and the health-check URL allowlist.
// ---------------------------------------------------------------------------

/**
 * Normalize an optional HTTP(S) URL string.
 *
 * - Trims whitespace
 * - Returns `undefined` for empty or missing values
 * - Validates that protocol is http or https
 * - Returns canonical `.toString()` representation
 *
 * @param value - Potential URL value from user input
 * @param fieldName - Friendly field name for error messages
 * @throws Error if the URL is present but invalid or not http(s)
 */
export function normalizeOptionalHttpUrl(value: unknown, fieldName = 'value'): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error(`${fieldName} must use http or https`);
    }
    return parsed.toString();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(fieldName)) {
      throw error;
    }
    throw new Error(`${fieldName} must be a valid http(s) URL`);
  }
}

/**
 * Validates that a health check URL targets an allowed destination.
 *
 * Blocks:
 * - Non-HTTP(S) protocols (file://, gopher://, etc.) — via normalizeOptionalHttpUrl
 * - Cloud metadata endpoints (169.254.x.x link-local range, metadata.google.internal)
 * - IPv6 link-local addresses (fe80::) and AWS IPv6 metadata (fd00:ec2::254)
 *
 * Allows localhost/127.0.0.1 since health checks legitimately target local services.
 */
export function isAllowedHealthCheckUrl(urlString: string): boolean {
  // Reuse existing protocol validation (http/https only, rejects non-string/empty/non-http)
  let normalized: string | undefined;
  try {
    normalized = normalizeOptionalHttpUrl(urlString, 'health_check_url');
  } catch {
    return false;
  }
  if (!normalized) return false;

  const url = new URL(normalized);
  const hostname = url.hostname;

  // Block cloud metadata endpoints
  if (hostname.startsWith('169.254.')) return false; // AWS/Azure link-local metadata
  if (hostname.startsWith('[fe80:')) return false; // IPv6 link-local
  if (hostname === 'metadata.google.internal') return false; // GCP metadata
  if (hostname === '[fd00:ec2::254]') return false; // AWS IPv6 metadata

  return true;
}
