/**
 * URL normalization utilities
 *
 * Provides shared helpers for validating and normalizing user-provided URLs,
 * plus builders for the entity deep-link URL scheme served by the UI app.
 */

import { shortId } from '../lib/ids';
import type { ArtifactID, BoardID, SessionID, WorktreeID } from '../types/id';

/**
 * UI mount path. The bundled UI is served at `${baseUrl}/ui/*` (see
 * `apps/agor-daemon/src/index.ts:449-466`) and the React app uses
 * `BrowserRouter basename='/ui'`, so external links MUST include this
 * prefix to land in the SPA. Trailing slash on built URLs is Django-style
 * — matches the routes declared in `apps/agor-ui/src/App.tsx`.
 */
const UI_MOUNT_PATH = '/ui';

/** Resolve the `<board>` segment for a URL, preferring slug for
 *  human-readability, falling back to short ID. */
function boardParam(boardId: BoardID, boardSlug: string | null | undefined): string {
  return boardSlug || shortId(boardId);
}

/** Build the `${baseUrl}/ui/b/<board>/` prefix used by every entity URL. */
function boardPrefix(
  boardId: BoardID,
  boardSlug: string | null | undefined,
  baseUrl: string
): string {
  return `${baseUrl}${UI_MOUNT_PATH}/b/${boardParam(boardId, boardSlug)}/`;
}

/**
 * Generate a session URL (`{baseUrl}/ui/b/<board>/<sessionShort>/`).
 *
 * @returns `null` if `boardId` is missing — sessions on un-placed
 * worktrees aren't navigable.
 */
export function getSessionUrl(
  sessionId: SessionID,
  boardId: BoardID | null | undefined,
  boardSlug: string | null | undefined,
  baseUrl: string
): string | null {
  if (!boardId) return null;
  return `${boardPrefix(boardId, boardSlug, baseUrl)}${shortId(sessionId)}/`;
}

/** Generate a board URL (`{baseUrl}/ui/b/<board>/`). */
export function getBoardUrl(
  boardId: BoardID,
  boardSlug: string | null | undefined,
  baseUrl: string
): string {
  return boardPrefix(boardId, boardSlug, baseUrl);
}

/**
 * Generate a worktree-focus URL (`{baseUrl}/ui/b/<board>/w/<worktreeShort>/`).
 * Shareable deep link — visiting the URL switches to the worktree's
 * board (if needed) and recenters the canvas on the worktree card. See
 * `apps/agor-ui/src/hooks/useUrlState.ts` for the consumer.
 *
 * @returns `null` if the worktree isn't placed on a board.
 */
export function getWorktreeUrl(
  worktreeId: WorktreeID,
  boardId: BoardID | null | undefined,
  boardSlug: string | null | undefined,
  baseUrl: string
): string | null {
  if (!boardId) return null;
  return `${boardPrefix(boardId, boardSlug, baseUrl)}w/${shortId(worktreeId)}/`;
}

/**
 * Generate an artifact-focus URL (`{baseUrl}/ui/b/<board>/a/<artifactShort>/`).
 * Mirrors `getWorktreeUrl` for artifacts.
 *
 * @returns `null` if the artifact isn't placed on a board.
 */
export function getArtifactUrl(
  artifactId: ArtifactID,
  boardId: BoardID | null | undefined,
  boardSlug: string | null | undefined,
  baseUrl: string
): string | null {
  if (!boardId) return null;
  return `${boardPrefix(boardId, boardSlug, baseUrl)}a/${shortId(artifactId)}/`;
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
