/**
 * MCP Session Tokens (jti + exp + gen + revocation ledger)
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
 * - `jti`  — per-issuance UUID, lets operators revoke a single token
 * - `gen`  — the session's `mcp_token_generation` at mint time; a mismatch
 *            against the current DB value invalidates the token in one write
 *            (used for "revoke all outstanding tokens for this session")
 *
 * Revocation strategies:
 *   1. `revokeByJti(jti)`              — insert row into `mcp_token_revocations`
 *   2. `revokeAllForSession(sessionId)`— bump `sessions.mcp_token_generation`
 *
 * Cache: active revocations are kept in an in-process `Set<string>` seeded at
 * init and refreshed on each write, so `validateSessionToken` does not hit the
 * DB per request for the ledger check.
 *
 * Legacy tokens: tokens minted before this change have no `jti`/`exp` claims.
 * They are accepted for a grace window after daemon startup (default: 7 days)
 * with a WARN log per use so operators can see which sessions still need to
 * reissue. Set `execution.mcp_token_accept_legacy_grace_ms = 0` to reject
 * immediately.
 */

import {
  type Database,
  deleteFrom,
  eq,
  generateId,
  isSQLiteDatabase,
  lte,
  mcpTokenRevocations,
  select,
  sessions,
  sql,
  update,
} from '@agor/core/db';
import type { Application } from '@agor/core/feathers';
import type { SessionID, UserID } from '@agor/core/types';
import jwt from 'jsonwebtoken';

// ============================================================================
// Types
// ============================================================================

export const MCP_TOKEN_AUDIENCE = 'agor:mcp:internal';
export const MCP_TOKEN_ISSUER = 'agor';

export type MCPTokenRevocationReason =
  | 'manual'
  | 'rotation'
  | 'session_archived'
  | 'session_completed'
  | 'user_request';

interface McpTokenPayload {
  sub: SessionID;
  uid: UserID;
  aud: string;
  iss?: string;
  iat?: number;
  exp?: number;
  jti?: string;
  gen?: number;
}

export interface McpTokenContext {
  sessionId: SessionID;
  userId: UserID;
  /** Present for post-rollout tokens; undefined for legacy tokens during grace. */
  jti?: string;
  /** Present for post-rollout tokens; undefined for legacy tokens during grace. */
  gen?: number;
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
  /** Expired-row pruning interval in ms (default: 1h). Set to 0 to disable. */
  cleanupIntervalMs?: number;
  /** Override `Date.now()` for tests. */
  now?: () => number;
}

// ============================================================================
// Module state
// ============================================================================

interface ModuleState {
  db: Database;
  expirationMs: number;
  acceptLegacyGraceMs: number;
  legacyGraceUntilMs: number;
  revokedJtis: Set<string>;
  cleanupInterval: NodeJS.Timeout | null;
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
 * Initialize the module. Loads the active revocation ledger into an in-memory
 * cache and schedules periodic pruning. Idempotent — calling again replaces
 * the previous state (tests rely on this).
 */
export async function initMcpTokens(options: McpTokenInitOptions): Promise<void> {
  const expirationMs = options.expirationMs ?? 24 * 60 * 60 * 1000;
  const acceptLegacyGraceMs = options.acceptLegacyGraceMs ?? 7 * 24 * 60 * 60 * 1000;
  const cleanupIntervalMs = options.cleanupIntervalMs ?? 60 * 60 * 1000;
  const now = options.now ?? (() => Date.now());

  const startupMs = now();
  const legacyGraceUntilMs = acceptLegacyGraceMs > 0 ? startupMs + acceptLegacyGraceMs : 0;

  // Seed revocation cache with non-expired rows. We read all rows and filter in
  // JS to keep the query dialect-neutral; the ledger is small by design.
  const rows = (await select(options.db).from(mcpTokenRevocations).all()) as Array<{
    jti: string;
    expires_at: number;
  }>;
  const revokedJtis = new Set<string>();
  for (const r of rows) {
    if (r.expires_at > startupMs) revokedJtis.add(r.jti);
  }

  if (_state?.cleanupInterval) {
    clearInterval(_state.cleanupInterval);
  }

  _state = {
    db: options.db,
    expirationMs,
    acceptLegacyGraceMs,
    legacyGraceUntilMs,
    revokedJtis,
    cleanupInterval: null,
    now,
  };

  if (cleanupIntervalMs > 0) {
    _state.cleanupInterval = setInterval(() => {
      void cleanupExpiredTokens().catch((err) => {
        console.error('[mcp-tokens] cleanup failed:', err);
      });
    }, cleanupIntervalMs);
    // Don't keep the event loop alive just for token GC.
    _state.cleanupInterval.unref?.();
  }

  console.log(
    `[mcp-tokens] initialized: exp=${expirationMs}ms, legacy_grace=${acceptLegacyGraceMs}ms, active_revocations=${revokedJtis.size}`
  );
}

/**
 * Tear down the module. Tests only; production uses process exit.
 */
export function shutdownMcpTokens(): void {
  if (_state?.cleanupInterval) {
    clearInterval(_state.cleanupInterval);
  }
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
 * Mint a fresh MCP token for a session. Looks up the session's current
 * `mcp_token_generation` and embeds it as the `gen` claim.
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

  // Fetch current generation for this session. If the session vanished (race
  // with delete), fall back to gen=0 — the token is useless either way.
  const row = (await select(s.db)
    .from(sessions)
    .where(eq(sessions.session_id, sessionId))
    .one()) as { mcp_token_generation?: number } | null;

  const gen = row?.mcp_token_generation ?? 0;
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
    gen,
  };

  const token = jwt.sign(payload, jwtSecret, { algorithm: 'HS256' });

  console.log(
    `🎫 MCP token issued: session=${sessionId.substring(0, 8)} jti=${jti.substring(0, 8)} gen=${gen} exp=+${Math.floor(s.expirationMs / 1000)}s`
  );

  return token;
}

/**
 * Convenience alias kept for callers that already used this name.
 */
export const getTokenForSession = generateSessionToken;

// ============================================================================
// Validation
// ============================================================================

/**
 * Validate an MCP token and extract `{ sessionId, userId, jti, gen }`.
 *
 * Rejection reasons:
 *  - bad signature / wrong audience / expired (`jsonwebtoken.verify`)
 *  - `gen` mismatch against session's current `mcp_token_generation`
 *  - `jti` present in the revocation cache
 *  - legacy token (no `jti`) arriving after the grace window
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
  try {
    payload = jwt.verify(token, jwtSecret, {
      audience: MCP_TOKEN_AUDIENCE,
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

  // Legacy token: no jti + no exp. Accept only during grace window, with WARN.
  if (payload.jti === undefined || payload.exp === undefined) {
    const nowMs = s.now();
    if (s.legacyGraceUntilMs > 0 && nowMs <= s.legacyGraceUntilMs) {
      console.warn(
        `[mcp-tokens] LEGACY token accepted (grace window active, ${Math.ceil((s.legacyGraceUntilMs - nowMs) / 1000)}s remaining): session=${sessionId.substring(0, 8)} uid=${userId.substring(0, 8)} — reissue by restarting the session`
      );
      return { sessionId, userId, legacy: true };
    }
    console.warn(
      `[mcp-tokens] LEGACY token rejected (grace window expired): session=${sessionId.substring(0, 8)} uid=${userId.substring(0, 8)}`
    );
    return null;
  }

  // Fast path: jti in revocation cache.
  if (s.revokedJtis.has(payload.jti)) {
    console.warn(`[mcp-tokens] token rejected: jti ${payload.jti.substring(0, 8)} revoked`);
    return null;
  }

  // Generation check — a bumped gen invalidates every outstanding token.
  const row = (await select(s.db)
    .from(sessions)
    .where(eq(sessions.session_id, sessionId))
    .one()) as { mcp_token_generation?: number } | null;

  if (!row) {
    console.warn(`[mcp-tokens] token rejected: session ${sessionId.substring(0, 8)} not found`);
    return null;
  }

  const currentGen = row.mcp_token_generation ?? 0;
  const tokenGen = payload.gen ?? 0;
  if (tokenGen !== currentGen) {
    console.warn(
      `[mcp-tokens] token rejected: gen mismatch (token=${tokenGen} current=${currentGen}) session=${sessionId.substring(0, 8)}`
    );
    return null;
  }

  return { sessionId, userId, jti: payload.jti, gen: tokenGen };
}

// ============================================================================
// Revocation
// ============================================================================

export interface RevokeByJtiOptions {
  jti: string;
  sessionId?: SessionID;
  reason: MCPTokenRevocationReason;
  revokedBy?: string;
  /**
   * JWT `exp` (unix seconds) of the revoked token. The row can be pruned past
   * this, because the token's own `exp` already rejects it. If omitted we
   * default to `now + expirationMs`.
   */
  tokenExpSec?: number;
}

/**
 * Revoke a single token by its `jti`. Idempotent: replaying the same jti
 * updates metadata but does not error. Updates the in-memory cache.
 */
export async function revokeByJti(options: RevokeByJtiOptions): Promise<void> {
  const s = requireState();
  const nowMs = s.now();
  const expiresAtMs =
    options.tokenExpSec !== undefined ? options.tokenExpSec * 1000 : nowMs + s.expirationMs;

  // Upsert-ish semantics: idempotent insert. onConflictDoNothing is supported
  // by both dialects of Drizzle.
  const values = {
    jti: options.jti,
    session_id: options.sessionId ?? null,
    revoked_at: nowMs,
    revoked_by: options.revokedBy ?? null,
    reason: options.reason,
    expires_at: expiresAtMs,
  };
  if (isSQLiteDatabase(s.db)) {
    await s.db.insert(mcpTokenRevocations).values(values).onConflictDoNothing().run();
  } else {
    // biome-ignore lint/suspicious/noExplicitAny: cross-dialect insert
    await (s.db as any).insert(mcpTokenRevocations).values(values).onConflictDoNothing();
  }

  s.revokedJtis.add(options.jti);

  console.log(
    `[mcp-tokens] revoked jti=${options.jti.substring(0, 8)} reason=${options.reason} revoked_by=${options.revokedBy ?? 'system'}`
  );
}

/**
 * Revoke every outstanding MCP token for a session by bumping its
 * `mcp_token_generation` counter. Cheap, O(1) write. Returns the new gen.
 *
 * The revocation ledger is NOT touched here — this is the "revoke all" path.
 * Individual-jti revocation is for leaked-token cases where the session is
 * still in use.
 */
export async function revokeAllForSession(
  db: Database,
  sessionId: SessionID,
  _reason: MCPTokenRevocationReason,
  _revokedBy?: string
): Promise<number> {
  // Increment atomically. `sql` works for both dialects.
  await update(db, sessions)
    .set({ mcp_token_generation: sql`${sessions.mcp_token_generation} + 1` })
    .where(eq(sessions.session_id, sessionId))
    .run();

  // Read back to report the new gen.
  const row = (await select(db).from(sessions).where(eq(sessions.session_id, sessionId)).one()) as {
    mcp_token_generation?: number;
  } | null;

  const newGen = row?.mcp_token_generation ?? 0;
  console.log(
    `[mcp-tokens] revoke-all for session=${sessionId.substring(0, 8)} reason=${_reason} revoked_by=${_revokedBy ?? 'system'} new_gen=${newGen}`
  );
  return newGen;
}

// ============================================================================
// Cleanup
// ============================================================================

/**
 * Delete revocation rows whose `expires_at` has passed — the token's own `exp`
 * already rejects them, so we no longer need to check the ledger.
 *
 * Returns the number of rows deleted.
 */
export async function cleanupExpiredTokens(): Promise<number> {
  const s = requireState();
  const nowMs = s.now();

  const res = await deleteFrom(s.db, mcpTokenRevocations)
    .where(lte(mcpTokenRevocations.expires_at, nowMs))
    .run();

  const rowsAffected = res?.rowsAffected ?? 0;

  // Rebuild the cache from scratch from the surviving rows. This also handles
  // the (rare) case where the DB was mutated out from under us.
  const rows = (await select(s.db).from(mcpTokenRevocations).all()) as Array<{
    jti: string;
    expires_at: number;
  }>;
  s.revokedJtis = new Set(rows.filter((r) => r.expires_at > nowMs).map((r) => r.jti));

  if (rowsAffected > 0) {
    console.log(
      `[mcp-tokens] pruned ${rowsAffected} expired revocation(s); ${s.revokedJtis.size} active remaining`
    );
  }

  return rowsAffected;
}

// ============================================================================
// Revocation service (REST-facing)
// ============================================================================

/**
 * Thin service class exposed via `/mcp-tokens`. Wraps the module functions so
 * Feathers can register it as a service and apply auth hooks. The actual
 * per-jti revocation logic stays in this module.
 */
export class MCPTokensService {
  constructor(private readonly db: Database) {}

  /**
   * Admin-only: revoke a single token by jti. See `register-routes.ts` for
   * the hook that enforces admin role.
   */
  async revoke(
    jti: string,
    options: { reason?: MCPTokenRevocationReason; revokedBy?: string; sessionId?: SessionID } = {}
  ): Promise<{ jti: string; revoked_at: number; reason: MCPTokenRevocationReason }> {
    const reason = options.reason ?? 'manual';
    const nowMs = Date.now();
    await revokeByJti({
      jti,
      sessionId: options.sessionId,
      reason,
      revokedBy: options.revokedBy,
    });
    return { jti, revoked_at: nowMs, reason };
  }

  /**
   * List active (non-expired) revocations. Useful for audit UIs.
   */
  async list(): Promise<
    Array<{
      jti: string;
      session_id: string | null;
      revoked_at: number;
      revoked_by: string | null;
      reason: string;
      expires_at: number;
    }>
  > {
    const rows = (await select(this.db).from(mcpTokenRevocations).all()) as Array<{
      jti: string;
      session_id: string | null;
      revoked_at: number;
      revoked_by: string | null;
      reason: string;
      expires_at: number;
    }>;
    const now = Date.now();
    return rows.filter((r) => r.expires_at > now);
  }
}
