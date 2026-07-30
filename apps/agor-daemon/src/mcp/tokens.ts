/**
 * MCP Session Tokens (jti + exp)
 *
 * MCP tokens authenticate internal daemon ↔ MCP-server communication (aud:
 * `agor:mcp:internal`). Each issued token carries:
 *
 * - `sub`  — session id
 * - `uid`  — user id
 * - `tid`  — tenant id
 * - `aud`  — `agor:mcp:internal`
 * - `iss`  — `agor`
 * - `iat`  — unix seconds, standard JWT "issued at"
 * - `exp`  — unix seconds, enforced by `jsonwebtoken.verify`
 * - `jti`  — per-issuance UUID (useful for log correlation)
 *
 * No revocation mechanics. Tokens are minted lazily and cached briefly per
 * `(tenant,session,user)` so high-frequency `session.get` calls don't perform
 * redundant JWT signing and session-existence probes. Tokens carry a short
 * `exp` (default 24h); any suspected
 * compromise is addressed by rotating the JWT signing secret or letting the
 * token expire. MCP is internal-only (loopback) — if/when it goes external
 * we'd design auth from scratch (OAuth / API keys) rather than extending this.
 *
 * A session-existence check is still performed during validation so tokens
 * for deleted sessions are rejected even if they haven't yet hit their `exp`.
 */

import {
  MCP_TOKEN,
  type ResolvedMultiTenancyConfig,
  resolveTenantContext,
  TenantResolutionError,
} from '@agor/core/config';
import {
  generateId,
  getCurrentTenantId,
  runWithTenantContext,
  runWithTenantDatabaseScope,
  SessionRepository,
  shortId,
  type TenantScopeAwareDatabase,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import {
  MCP_TOKEN_AUDIENCE,
  MCP_TOKEN_ISSUER,
  type SessionID,
  type TenantID,
  type UserID,
} from '@agor/core/types';
import jwt from 'jsonwebtoken';

const DEBUG_MCP_TOKENS =
  process.env.AGOR_DEBUG_MCP_TOKENS === '1' || process.env.DEBUG?.includes('mcp-tokens');

function mcpTokenDebug(...args: unknown[]): void {
  if (DEBUG_MCP_TOKENS) {
    console.debug(...args);
  }
}

// Re-exported so daemon callers don't have to reach into @agor/core/types.
export { MCP_TOKEN_AUDIENCE, MCP_TOKEN_ISSUER } from '@agor/core/types';

// ============================================================================
// Types
// ============================================================================

interface McpTokenPayload {
  sub: SessionID;
  uid: UserID;
  tid: TenantID;
  aud: string;
  iss?: string;
  iat?: number;
  exp?: number;
  jti?: string;
}

export interface McpTokenContext {
  sessionId: SessionID;
  userId: UserID;
  tenantId: TenantID;
  jti: string;
}

export interface McpTokenInitOptions {
  db: TenantScopeAwareDatabase;
  /**
   * Resolved daemon tenant policy. Issuance may use the configured tenant only
   * in static mode; required_from_auth still needs an ambient tenant identity.
   */
  multiTenancy: ResolvedMultiTenancyConfig;
  /** Token lifetime in ms. Falls back to `MCP_TOKEN.DEFAULT_EXPIRATION_MS` (24h). */
  expirationMs?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

// ============================================================================
// Module state
// ============================================================================

interface ModuleState {
  db: TenantScopeAwareDatabase;
  sessionRepo: SessionRepository;
  multiTenancy: ResolvedMultiTenancyConfig;
  expirationMs: number;
  now: () => number;
  tokenCache: Map<string, CachedMcpToken>;
  lastCachePruneAtMs: number;
}

interface CachedMcpToken {
  token: string;
  expiresAtMs: number;
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
    db: options.db,
    sessionRepo: new SessionRepository(options.db),
    multiTenancy: options.multiTenancy,
    expirationMs,
    now,
    tokenCache: new Map(),
    lastCachePruneAtMs: 0,
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
 * Resolve the tenant binding for a new token through the canonical config
 * resolver. Ambient identity is passed as an explicit trusted daemon signal:
 *
 * - static mode falls back to its configured tenant when ambient identity is
 *   absent;
 * - an ambient identity must agree with the configured static tenant;
 * - required_from_auth accepts an ambient identity but fails closed without
 *   one.
 */
function resolveIssuanceTenantId(state: ModuleState): TenantID {
  const ambientTenantId = getCurrentTenantId();
  try {
    if (
      ambientTenantId !== undefined &&
      (!ambientTenantId.trim() || ambientTenantId.trim() !== ambientTenantId)
    ) {
      throw new TenantResolutionError('Invalid ambient tenant identity');
    }
    return resolveTenantContext(
      state.multiTenancy,
      ambientTenantId
        ? {
            params: { tenant_id: ambientTenantId },
          }
        : undefined
    ).tenant_id;
  } catch (error) {
    if (error instanceof TenantResolutionError) {
      const message = error.message.startsWith('Missing tenant context')
        ? 'missing active tenant context'
        : error.message;
      throw new Error(`MCP token generation failed: ${message}`, { cause: error });
    }
    throw error;
  }
}

/**
 * Mint or reuse an MCP token for a session.
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

  const nowMs = s.now();
  const tenantId = resolveIssuanceTenantId(s);
  if (nowMs - s.lastCachePruneAtMs > 5 * 60 * 1000) {
    for (const [key, entry] of s.tokenCache) {
      if (entry.expiresAtMs <= nowMs) {
        s.tokenCache.delete(key);
      }
    }
    s.lastCachePruneAtMs = nowMs;
  }

  const cacheKey = `${tenantId}:${sessionId}:${userId}`;
  const cached = s.tokenCache.get(cacheKey);
  // Keep a buffer so callers never receive a token that is about to expire.
  const refreshBufferMs = Math.min(5 * 60 * 1000, Math.max(30 * 1000, s.expirationMs * 0.1));
  if (cached && cached.expiresAtMs - nowMs > refreshBufferMs) {
    mcpTokenDebug(`🎫 MCP token cache hit: session=${shortId(sessionId)}`);
    return cached.token;
  }

  const sessionExists = await runWithTenantDatabaseScope(s.db, tenantId, () =>
    s.sessionRepo.exists(sessionId)
  );
  if (!sessionExists) {
    s.tokenCache.delete(cacheKey);
    throw new Error(
      `MCP token generation failed: session ${sessionId} not found — cannot mint token for a non-existent session`
    );
  }

  const nowSec = Math.floor(nowMs / 1000);
  const expSec = nowSec + Math.floor(s.expirationMs / 1000);
  const expiresAtMs = expSec * 1000;
  const jti = generateId();

  const payload: McpTokenPayload = {
    sub: sessionId,
    uid: userId,
    tid: tenantId,
    aud: MCP_TOKEN_AUDIENCE,
    iss: MCP_TOKEN_ISSUER,
    iat: nowSec,
    exp: expSec,
    jti,
  };

  const token = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });
  s.tokenCache.set(cacheKey, { token, expiresAtMs });

  mcpTokenDebug(
    `🎫 MCP token issued: session=${shortId(sessionId)} jti=${jti.substring(0, 8)} exp=+${Math.floor(s.expirationMs / 1000)}s`
  );

  return token;
}

/** Convenience alias kept for callers that already used this name. */
export const getTokenForSession = generateSessionToken;

// ============================================================================
// Validation
// ============================================================================

/**
 * Cryptographically verify an MCP token without touching tenant-owned data.
 * Callers can use the signed tenant binding to establish the tenant scope
 * before validating session/user existence.
 *
 * Rejection reasons:
 *  - bad signature / wrong audience / wrong issuer / expired (`jsonwebtoken.verify`)
 *  - missing `tid`/`jti`/`exp` claims (pre-rollout tokens are rejected outright)
 *
 * Returns `null` on any failure.
 */
export function verifySessionToken(app: Application, token: string): McpTokenContext | null {
  requireState();
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
  const tenantId = payload.tid;
  if (
    typeof sessionId !== 'string' ||
    !sessionId ||
    typeof userId !== 'string' ||
    !userId ||
    typeof tenantId !== 'string' ||
    !tenantId.trim()
  ) {
    console.warn('[mcp-tokens] token rejected: missing sub/uid/tid');
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

  return { sessionId, userId, tenantId: tenantId.trim() as TenantID, jti: payload.jti };
}

/**
 * Validate the tenant-owned state referenced by an already verified token.
 * The signed tenant is entered before the session lookup, and the transaction
 * lasts only for that lookup.
 */
export async function validateVerifiedSessionToken(
  context: McpTokenContext
): Promise<McpTokenContext | null> {
  const s = requireState();
  const sessionExists = await runWithTenantContext(context.tenantId, () =>
    runWithTenantDatabaseScope(s.db, context.tenantId, () =>
      s.sessionRepo.exists(context.sessionId)
    )
  );
  if (!sessionExists) {
    console.warn(
      `[mcp-tokens] token rejected: session ${shortId(context.sessionId)} not found in bound tenant`
    );
    return null;
  }

  return context;
}

/**
 * Verify a token and validate its session inside the signed tenant.
 * `expectedTenantId` lets an HTTP boundary require agreement with a static or
 * trusted-header tenant before any database lookup occurs.
 */
export async function validateSessionToken(
  app: Application,
  token: string,
  expectedTenantId?: TenantID | string
): Promise<McpTokenContext | null> {
  const context = verifySessionToken(app, token);
  if (!context) return null;
  if (expectedTenantId && expectedTenantId !== context.tenantId) {
    console.warn('[mcp-tokens] token rejected: tenant binding mismatch');
    return null;
  }
  return validateVerifiedSessionToken(context);
}
