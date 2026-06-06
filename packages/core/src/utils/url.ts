/**
 * URL & path utilities
 *
 * Single source of truth for:
 *   1. The path shape rendered by the UI router and consumed by share
 *      links — top-level entity paths (`/b/<board>/`, `/s/<sessionShort>/`,
 *      `/w/<branchShort>/`, `/a/<artifactShort>/`).
 *   2. The UI mount point (`/ui`) at which the daemon serves the SPA.
 *   3. Composition of full external URLs (`baseUrl + UI_MOUNT_PATH +
 *      path`) handed back through REST / MCP responses.
 *
 * Design note — flat entity URLs: sub-entities (sessions, branches,
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
import type { ArtifactID, BoardID, BranchID, SessionID } from '../types/id';
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
  branch: 'w',
  artifact: 'a',
  knowledge: 'kb',
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
 *  switches to its branch's board, and opens the conversation panel. */
export function sessionPath(sessionId: SessionID): string {
  return `/${ENTITY_PATH_SEGMENTS.session}/${shortId(sessionId)}/`;
}

/** `/w/<branchShort>/` — branch deep link. App resolves the
 *  branch, switches to its board, and recenters the canvas on its card. */
export function branchPath(branchId: BranchID): string {
  return `/${ENTITY_PATH_SEGMENTS.branch}/${shortId(branchId)}/`;
}

/** `/a/<artifactShort>/` — artifact deep link. Same shape as branch. */
export function artifactPath(artifactId: ArtifactID): string {
  return `/${ENTITY_PATH_SEGMENTS.artifact}/${shortId(artifactId)}/`;
}

function encodePathSegments(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** `/kb/<namespace>/<document/path.md>` — Knowledge page deep link.
 *  Documents are addressed by their stable namespace + path key rather
 *  than an opaque document ID so links mirror `agor://kb/...` URIs and
 *  future import/export layouts. */
export function knowledgePath(namespaceSlug?: string | null, documentPath?: string | null): string {
  const base = `/${ENTITY_PATH_SEGMENTS.knowledge}`;
  if (!namespaceSlug) return base;
  const namespacePath = `${base}/${encodeURIComponent(namespaceSlug)}`;
  if (!documentPath) return `${namespacePath}/`;
  return `${namespacePath}/${encodePathSegments(documentPath)}`;
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
 *  Also strips a trailing `/ui` suffix so operators who set
 *  `daemon.base_url` to the full UI address (e.g. `https://agor.example.com/ui`)
 *  don't end up with double-prefixed `/ui/ui/...` entity URLs.
 *  `baseUrl` here comes from `getBaseUrl()` in config-manager, which
 *  reads `daemon.base_url` (with an `AGOR_BASE_URL` env override). */
function fullUrl(path: string, baseUrl: string): string {
  // Strip trailing slash first, then any trailing /ui suffix.
  let base = baseUrl.replace(/\/$/, '');
  if (base.endsWith(UI_MOUNT_PATH)) {
    base = base.slice(0, -UI_MOUNT_PATH.length);
  }
  return `${base}${UI_MOUNT_PATH}${path}`;
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

/** Generate a branch URL. Always returns a URL — the entity resolves
 *  to its board at click time. */
export function getBranchUrl(branchId: BranchID, baseUrl: string): string {
  return fullUrl(branchPath(branchId), baseUrl);
}

/** Generate an artifact URL. Always returns a URL — the entity
 *  resolves to its board at click time. */
export function getArtifactUrl(artifactId: ArtifactID, baseUrl: string): string {
  return fullUrl(artifactPath(artifactId), baseUrl);
}

/** Generate a Knowledge URL from namespace + optional document path. */
export function getKnowledgeUrl(
  namespaceSlug: string | null | undefined,
  documentPath: string | null | undefined,
  baseUrl: string
): string {
  return fullUrl(knowledgePath(namespaceSlug, documentPath), baseUrl);
}

// ---------------------------------------------------------------------------
// Unrelated user-input validation helpers — kept here for historical
// reasons. Used by branch issue_url / pull_request_url normalization
// and the health-check URL allowlist.
// ---------------------------------------------------------------------------

/**
 * Replace URL userinfo with `<redacted>` for logs/errors.
 *
 * This is intentionally string-based rather than `new URL(...)` only:
 * defensive redaction has to work even when a user pasted a malformed URL
 * such as one with an unescaped `@` inside the password. The userinfo match is
 * greedy within the URL authority, so it redacts through the last `@` before a
 * path/query/hash delimiter.
 *
 * SCP-like Git remotes (`git@host:org/repo.git`) do not contain `://`, so they
 * are left untouched.
 */
export function redactUrlUserinfo(input: string): string {
  return input.replace(
    /([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#\s]*@)([^/?#\s]+)/g,
    (_match, prefix: string, _userinfo: string, host: string) => `${prefix}<redacted>@${host}`
  );
}

/** True when an HTTP(S) URL embeds URL userinfo (`https://USER[:PASS]@host/...`). */
export function httpUrlHasUserinfo(rawUrl: string): boolean {
  if (!/^https?:\/\//i.test(rawUrl)) return false;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
    return parsed.username.length > 0 || parsed.password.length > 0;
  } catch {
    return /^https?:\/\/[^/?#\s]*@[^/?#\s]+/i.test(rawUrl);
  }
}

/**
 * Remove userinfo from HTTP(S) URLs. Non-HTTP(S) URLs, including SSH Git
 * remotes like `ssh://git@host/org/repo.git`, are returned unchanged because
 * their userinfo position may be a legitimate login name rather than a secret.
 */
export function stripHttpUrlUserinfo(rawUrl: string): string {
  if (!/^https?:\/\//i.test(rawUrl)) return rawUrl;
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return rawUrl;
    if (parsed.username || parsed.password) {
      parsed.username = '';
      parsed.password = '';
      return parsed.toString();
    }
    return rawUrl;
  } catch {
    return rawUrl.replace(/^(https?:\/\/)([^/?#\s]*@)([^/?#\s]+)/i, '$1$3');
  }
}

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
