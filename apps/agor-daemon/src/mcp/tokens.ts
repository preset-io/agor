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
 */

import { MCP_TOKEN } from '@agor/core/config';
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
  jti: string;
}

export interface McpTokenInitOptions {
  db: Database;
  /** Token lifetime in ms. Falls back to `MCP_TOKEN.DEFAULT_EXPIRATION_MS` (24h). */
  expirationMs?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

// ============================================================================
// Module state
// ============================================================================

interface ModuleState {
  sessionRepo: SessionRepository;
  expirationMs: number;
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
  const expirationMs = options.expirationMs ?? MCP_TOKEN.DEFAULT_EXPIRATION_MS;
  const now = options.now ?? (() => Date.now());

  _state = {
    sessionRepo: new SessionRepository(options.db),
    expirationMs,
    now,
  };

  console.log(`[mcp-tokens] initialized: exp=${expirationMs}ms`);
}

/**
 * Tear down the module. Tests only; production uses process exit.
 */
export function shutdownMcpTokens(): void {
  _state = null;
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
 *  - missing `jti`/`exp` claims (pre-rollout tokens are rejected outright)
 *  - session no longer exists
 *
 * Returns `null` on any failure.
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
  try {
    payload = jwt.verify(token, jwtSecret, {
      audience: MCP_TOKEN_AUDIENCE,
      issuer: MCP_TOKEN_ISSUER,
      algorithms: ['HS256'],
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

  // `jwt.verify` only enforces `exp` when the claim is present; a token with
  // no `exp` would otherwise pass verify and be valid forever. Enforce both
  // `jti` and `exp` explicitly so a forged but signature-valid token without
  // `exp` cannot be minted and replayed indefinitely.
  if (!payload.jti || payload.exp === undefined) {
    console.warn('[mcp-tokens] token rejected: missing jti or exp');
    return null;
  }

  // Reject tokens whose session has been deleted — protects against stale
  // tokens outliving their session until `exp`.
  const sessionExists = await s.sessionRepo.exists(sessionId);
  if (!sessionExists) {
    console.warn(`[mcp-tokens] token rejected: session ${sessionId.substring(0, 8)} not found`);
    return null;
  }

  return { sessionId, userId, jti: payload.jti };
}
