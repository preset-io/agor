/**
 * MCP Session Tokens (jti + exp)
 *
 * MCP tokens authenticate internal daemon ↔ MCP-server communication (aud:
 * `agor:mcp:internal`). Each issued token carries:
 *
 * - `sub`  — session id
 * - `uid`  — user id
 * - `aud`  — `agor:mcp:internal`
 * - `iss`  — `agor`
 * - `iat`  — unix seconds, standard JWT "issued at"
 * - `exp`  — unix seconds, enforced by `jsonwebtoken.verify`
 * - `jti`  — per-issuance UUID (useful for log correlation)
 *
 * No revocation mechanics. Tokens are re-minted fresh on every `session.get` /
 * `session.create` and carry a short `exp` (default 24h); any suspected
 * compromise is addressed by rotating the JWT signing secret or letting the
 * token expire. MCP is internal-only (loopback) — if/when it goes external
 * we'd design auth from scratch (OAuth / API keys) rather than extending this.
 *
 * A session-existence check is still performed during validation so tokens
 * for deleted sessions are rejected even if they haven't yet hit their `exp`.
 *
 * Legacy tokens: tokens minted before this change have no `jti`/`exp` claims.
 * They are accepted for a grace window after daemon startup (default: 7 days)
 * with a WARN log per use so operators can see which sessions still need to
 * reissue. Set `execution.mcp_token_accept_legacy_grace_ms = 0` to reject
 * immediately.
 */

import { type Database, generateId, SessionRepository } from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  MCP_TOKEN_AUDIENCE,
  MCP_TOKEN_ISSUER,
  type SessionID,
  type UserID,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';

// Re-exported so daemon callers don't have to reach into @agor/core/types.
export { MCP_TOKEN_AUDIENCE, MCP_TOKEN_ISSUER } from '@agor/core/types';

// ============================================================================
// Types
// ============================================================================

interface McpTokenPayload {
  sub: SessionID;
  uid: UserID;
  aud: string;
  iss?: string;
  iat?: number;
  exp?: number;
  jti?: string;
}

export interface McpTokenContext {
  sessionId: SessionID;
  userId: UserID;
  /** Present for post-rollout tokens; undefined for legacy tokens during grace. */
  jti?: string;
  /** True when the token had no `jti`/`exp` claims and was accepted during grace. */
  legacy?: boolean;
}

export interface McpTokenInitOptions {
  db: Database;
  /** Token lifetime in ms (default: 24h). */
  expirationMs?: number;
  /**
   * How long after startup legacy (pre-rollout) tokens remain valid.
   * Default: 7 days. Set to 0 for a hard cut.
   */
  acceptLegacyGraceMs?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

// ============================================================================
// Module state
// ============================================================================

interface ModuleState {
  sessionRepo: SessionRepository;
  expirationMs: number;
  acceptLegacyGraceMs: number;
  legacyGraceUntilMs: number;
  now: () => number;
}

let _state: ModuleState | null = null;

function requireState(): ModuleState {
  if (!_state) {
    throw new Error(
      'MCP token module not initialized — call initMcpTokens({ db, ... }) at daemon startup'
    );
  }
  return _state;
}

// ============================================================================
// Init / shutdown
// ============================================================================

/**
 * Initialize the module. Idempotent — calling again replaces the previous
 * state (tests rely on this).
 */
export function initMcpTokens(options: McpTokenInitOptions): void {
  const expirationMs = options.expirationMs ?? 24 * 60 * 60 * 1000;
  const acceptLegacyGraceMs = options.acceptLegacyGraceMs ?? 7 * 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());

  const legacyGraceUntilMs = acceptLegacyGraceMs > 0 ? now() + acceptLegacyGraceMs : 0;

  _state = {
    sessionRepo: new SessionRepository(options.db),
    expirationMs,
    acceptLegacyGraceMs,
    legacyGraceUntilMs,
    now,
  };

  console.log(
    `[mcp-tokens] initialized: exp=${expirationMs}ms, legacy_grace=${acceptLegacyGraceMs}ms`
  );
}

/**
 * Tear down the module. Tests only; production uses process exit.
 */
export function shutdownMcpTokens(): void {
  _state = null;
}

/**
 * Current legacy grace expiry (ms since epoch). Exposed for observability and
 * test assertions; returns 0 when legacy tokens are rejected outright.
 */
export function getLegacyGraceUntilMs(): number {
  return _state?.legacyGraceUntilMs ?? 0;
}

// ============================================================================
// Issuance
// ============================================================================

/**
 * Mint a fresh MCP token for a session.
 *
 * @throws if the module isn't initialized, the session doesn't exist, or the
 *   app lacks a JWT secret.
 */
export async function generateSessionToken(
  app: Application,
  sessionId: SessionID,
  userId: UserID
): Promise<string> {
  const s = requireState();
  const jwtSecret = app.settings.authentication?.secret;
  if (!jwtSecret) {
    throw new Error('MCP token generation failed: JWT secret not configured in app settings');
  }

  const sessionExists = await s.sessionRepo.exists(sessionId);
  if (!sessionExists) {
    throw new Error(
      `MCP token generation failed: session ${sessionId} not found — cannot mint token for a non-existent session`
    );
  }

  const nowSec = Math.floor(s.now() / 1000);
  const expSec = nowSec + Math.floor(s.expirationMs / 1000);
  const jti = generateId();

  const payload: McpTokenPayload = {
    sub: sessionId,
    uid: userId,
    aud: MCP_TOKEN_AUDIENCE,
    iss: MCP_TOKEN_ISSUER,
    iat: nowSec,
    exp: expSec,
    jti,
  };

  const token = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

  console.log(
    `🎫 MCP token issued: session=${sessionId.substring(0, 8)} jti=${jti.substring(0, 8)} exp=+${Math.floor(s.expirationMs / 1000)}s`
  );

  return token;
}

/** Convenience alias kept for callers that already used this name. */
export const getTokenForSession = generateSessionToken;

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an MCP token and extract `{ sessionId, userId, jti }`.
 *
 * Rejection reasons:
 *  - bad signature / wrong audience / wrong issuer / expired (`jsonwebtoken.verify`)
 *  - legacy token (no `jti`) arriving after the grace window
 *  - session no longer exists
 *
 * Returns `null` on any failure; returns a context object (including
 * `legacy: true`) for accepted legacy tokens during the grace window.
 */
export async function validateSessionToken(
  app: Application,
  token: string
): Promise<McpTokenContext | null> {
  const s = requireState();
  const jwtSecret = app.settings.authentication?.secret;
  if (!jwtSecret) {
    console.error('[mcp-tokens] JWT secret not configured in app settings');
    return null;
  }

  let payload: McpTokenPayload;
  const isLegacyToken = !hasJtiAndExp(token);
  try {
    // Legacy tokens (pre-rollout) have no `exp` claim, so we skip `jwt.verify`'s
    // expiration + issuer checks for them; everything else (signature, audience,
    // algorithm, session) still applies via the code below.
    payload = jwt.verify(token, jwtSecret, {
      audience: MCP_TOKEN_AUDIENCE,
      algorithms: ['HS256'],
      ...(isLegacyToken ? {} : { issuer: MCP_TOKEN_ISSUER }),
    }) as McpTokenPayload;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      console.warn('[mcp-tokens] token rejected: expired');
    } else if (err instanceof jwt.JsonWebTokenError) {
      console.warn(`[mcp-tokens] token rejected: ${err.message}`);
    } else {
      console.error('[mcp-tokens] token verify error:', err);
    }
    return null;
  }

  const sessionId = payload.sub;
  const userId = payload.uid;
  if (!sessionId || !userId) {
    console.warn('[mcp-tokens] token rejected: missing sub/uid');
    return null;
  }

  const isLegacy = payload.jti === undefined || payload.exp === undefined;

  if (isLegacy) {
    const nowMs = s.now();
    if (!(s.legacyGraceUntilMs > 0 && nowMs <= s.legacyGraceUntilMs)) {
      console.warn(
        `[mcp-tokens] LEGACY token rejected (grace window expired): session=${sessionId.substring(0, 8)} uid=${userId.substring(0, 8)}`
      );
      return null;
    }
    console.warn(
      `[mcp-tokens] LEGACY token accepted (grace window active, ${Math.ceil((s.legacyGraceUntilMs - nowMs) / 1000)}s remaining): session=${sessionId.substring(0, 8)} uid=${userId.substring(0, 8)} — reissue by restarting the session`
    );
  }

  // Reject tokens whose session has been deleted — protects against stale
  // tokens outliving their session until `exp`.
  const sessionExists = await s.sessionRepo.exists(sessionId);
  if (!sessionExists) {
    console.warn(`[mcp-tokens] token rejected: session ${sessionId.substring(0, 8)} not found`);
    return null;
  }

  if (isLegacy) {
    return { sessionId, userId, legacy: true };
  }

  return { sessionId, userId, jti: payload.jti };
}

/**
 * Cheap peek at a JWT to detect the legacy-token shape (missing `jti`/`exp`)
 * WITHOUT verifying the signature. The subsequent `jwt.verify` is what
 * establishes trust — this is just used to decide which `verify` options to
 * pass (legacy tokens lack `exp`, so we skip `issuer` too for backward compat).
 */
function hasJtiAndExp(token: string): boolean {
  const decoded = jwt.decode(token) as McpTokenPayload | null;
  return decoded?.jti !== undefined && decoded?.exp !== undefined;
}
