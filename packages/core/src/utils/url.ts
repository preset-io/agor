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

/** `/a/<artifactShort>/fullscreen` — lightweight fullscreen artifact surface.
 *  Optional UI chrome is controlled client-side with `?show_navbar=false`. */
export function artifactFullscreenPath(artifactId: ArtifactID): string {
  return `/${ENTITY_PATH_SEGMENTS.artifact}/${shortId(artifactId)}/fullscreen`;
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
 *  base URL values (e.g. `https://agor.example.com/`) don't
 *  produce double-slashed URLs like `https://agor.example.com//ui/...`.
 *  Also strips a trailing `/ui` suffix so operators who set
 *  a base URL to the full UI address (e.g. `https://agor.example.com/ui`)
 *  don't end up with double-prefixed `/ui/ui/...` entity URLs.
 *  `baseUrl` here comes from `getBaseUrl()` in config-manager, which
 *  prefers `ui.base_url` before the daemon fallback. */
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

/** Generate a lightweight fullscreen artifact URL. Renders the artifact
 *  outside the board canvas/card chrome. Append `?show_navbar=false` to hide the
 *  compact navbar. */
export function getArtifactFullscreenUrl(artifactId: ArtifactID, baseUrl: string): string {
  return fullUrl(artifactFullscreenPath(artifactId), baseUrl);
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
 * Parse an IPv4 literal in any form `inet_aton` accepts.
 *
 * A dotted-quad check alone is not enough: `http://2130706433/`,
 * `http://0x7f.1/`, and `http://017700000001/` all reach 127.0.0.1, and a
 * browser-grade URL parser preserves them verbatim in `hostname`.
 *
 * Returns the address as a 32-bit number, or null when the host is not an IPv4
 * literal in any form.
 */
function parseIPv4Literal(host: string): number | null {
  const parts = host.split('.');
  if (parts.length > 4 || parts.length === 0) return null;

  const values: number[] = [];
  for (const part of parts) {
    if (part.length === 0) return null;
    let value: number;
    if (/^0[xX][0-9a-fA-F]+$/.test(part)) value = Number.parseInt(part.slice(2), 16);
    else if (/^0[0-7]+$/.test(part)) value = Number.parseInt(part.slice(1), 8);
    else if (/^\d+$/.test(part)) value = Number.parseInt(part, 10);
    else return null;
    if (!Number.isSafeInteger(value) || value < 0) return null;
    values.push(value);
  }

  // The last part absorbs the remaining octets: `10.1` is 10.0.0.1.
  const trailingOctets = 4 - values.length;
  const last = values.pop() as number;
  if (last >= 2 ** (8 * (trailingOctets + 1))) return null;
  if (values.some((value) => value > 255)) return null;

  let address = last;
  for (const [index, value] of values.entries()) {
    address += value * 2 ** (8 * (3 - index));
  }
  return address >>> 0;
}

/** True when a 32-bit IPv4 address is outside the public internet. */
function isPrivateIPv4(address: number): boolean {
  const octet = (shift: number): number => (address >>> shift) & 0xff;
  const a = octet(24);
  const b = octet(16);

  if (a === 0) return true; // 0.0.0.0/8 "this network"
  if (a === 10) return true; // RFC 1918
  if (a === 127) return true; // loopback
  if (a === 169 && b === 254) return true; // link-local incl. cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // RFC 1918
  if (a === 192 && b === 168) return true; // RFC 1918
  if (a === 100 && b >= 64 && b <= 127) return true; // RFC 6598 CGNAT
  if (a === 192 && b === 0) return true; // RFC 6890 protocol assignments
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

/** True when an IPv6 literal (already stripped of brackets) is not public. */
function isPrivateIPv6(host: string): boolean {
  const address = host.toLowerCase().split('%')[0];
  if (address === '::1' || address === '::' || address === '') return true;
  // fc00::/7 unique-local, fe80::/10 link-local.
  if (/^f[cd][0-9a-f]{0,2}:/.test(address)) return true;
  if (/^fe[89ab][0-9a-f]?:/.test(address)) return true;
  // IPv4-mapped and IPv4-compatible forms tunnel the whole IPv4 space through.
  // `URL` normalizes `::ffff:127.0.0.1` to the hex form `::ffff:7f00:1`, so
  // both spellings have to be recognised.
  const dotted = /^(?:::ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(address);
  if (dotted) {
    const parsed = parseIPv4Literal(dotted[1]);
    return parsed === null || isPrivateIPv4(parsed);
  }
  const hex = /^::(?:ffff:)?([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(address);
  if (hex) {
    const high = Number.parseInt(hex[1], 16);
    const low = Number.parseInt(hex[2], 16);
    return isPrivateIPv4(((high << 16) | low) >>> 0);
  }
  return false;
}

/**
 * True when a resolved IP literal is outside the public internet.
 *
 * Takes the numeric address a resolver returned, not a hostname, so it is the
 * check to apply between resolution and connection. Anything unparseable is
 * reported private: an address this cannot classify is not one to connect to.
 *
 * Kept here beside {@link isPublicHttpUrl} so both halves of the outbound
 * filter — the URL a caller was handed and the address it actually resolves to
 * — share one definition of "private". This file is browser-safe by design (see
 * the header note about `node:crypto`), so the resolve-and-pin machinery that
 * consumes this lives in `utils/pinned-fetch.ts` instead.
 */
export function isPrivateIpAddress(address: string): boolean {
  const literal = address.trim().replace(/^\[|\]$/g, '');
  if (!literal) return true;
  if (literal.includes(':')) return isPrivateIPv6(literal);
  const ipv4 = parseIPv4Literal(literal);
  return ipv4 === null || isPrivateIPv4(ipv4);
}

/**
 * True when a URL is safe to fetch from the daemon on behalf of untrusted input.
 *
 * Callers that follow a URL supplied by a third party — the MCP catalog's auth
 * probe fetches endpoints published to a public, unauthenticated registry, and
 * then whatever URL those endpoints name in a `WWW-Authenticate` header — need
 * this before every hop, not just the first. A single missed hop turns the
 * daemon into a blind SSRF proxy into its own private network.
 *
 * Refuses non-HTTP(S) schemes, embedded credentials, loopback, RFC 1918,
 * CGNAT, link-local (including cloud metadata), unique-local IPv6, and the
 * decimal/octal/hex and IPv4-mapped forms that spell the same addresses
 * differently.
 *
 * This is a literal-address filter and cannot be the whole story: `evil.com`
 * passes here and still resolves to 169.254.169.254. Untrusted destinations
 * must be reached through `createPinnedFetch`, which resolves the name, applies
 * {@link isPrivateIpAddress} to every answer, and connects to the address it
 * checked.
 */
export function isPublicHttpUrl(rawUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
  // Credentials in a third-party-supplied URL are never something to replay.
  if (url.username || url.password) return false;

  const host = url.hostname.toLowerCase();
  if (!host) return false;
  if (host === 'localhost' || host.endsWith('.localhost')) return false;
  if (host === 'metadata.google.internal') return false;

  // `URL.hostname` keeps IPv6 literals bracketed; nothing else may contain ':'.
  if (host.startsWith('[') && host.endsWith(']')) return !isPrivateIPv6(host.slice(1, -1));

  const ipv4 = parseIPv4Literal(host);
  if (ipv4 !== null) return !isPrivateIPv4(ipv4);

  return true;
}

/**
 * Validates that a health check URL targets an allowed destination.
 *
 * Blocks:
 * - Non-HTTP(S) protocols (file://, gopher://, etc.) — via normalizeOptionalHttpUrl
 * - Cloud metadata endpoints (169.254.x.x link-local range, metadata.google.internal)
 * - IPv6 link-local addresses (fe80::) and AWS IPv6 metadata (fd00:ec2::254)
 *
 * Deliberately weaker than {@link isPublicHttpUrl}: a health check legitimately
 * targets localhost and private networks, because that is where a branch's dev
 * server runs. Use `isPublicHttpUrl` for anything reached on behalf of
 * untrusted input.
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
