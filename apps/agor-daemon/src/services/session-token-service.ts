/**
 * SessionTokenService - executor-session JWT issuance and authority policy.
 *
 * Standalone SQLite preserves the historical process-local raw-token Map.
 * PostgreSQL stores only a SHA-256 fingerprint plus tenant/user/resource,
 * expiry, revocation, and use-policy facts. A valid JWT signature is necessary
 * but never sufficient: every authentication must also claim the authority row.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type ExecutorSessionTokenAuthorityClaim,
  type ExecutorSessionTokenAuthorityIssue,
  ExecutorSessionTokenAuthorityRepository,
  getCurrentTenantId,
  isPostgresDatabaseHandle,
  runWithoutTenantContext,
  runWithoutTenantDatabaseScope,
  runWithSystemDatabaseScope,
  runWithTenantDatabaseScope,
  type TenantScopeAwareDatabase,
  type TenantScopedDatabase,
} from '@agor/core/db';
import jwt from 'jsonwebtoken';
import {
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from '../auth/executor-session-token.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';

const DEBUG_SESSION_TOKENS =
  process.env.AGOR_DEBUG_SESSION_TOKENS === '1' || process.env.DEBUG?.includes('session-token');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_TENANT_LIMIT = 1_000;
export const EXECUTOR_SESSION_TOKEN_AUTHORITY_RETENTION_MS = 24 * 60 * 60 * 1000;

function sessionTokenDebug(result: string): void {
  if (DEBUG_SESSION_TOKENS) {
    // Only a bounded result category is permitted here. Bearers, fingerprints,
    // claims, scopes, and database errors are intentionally omitted.
    console.debug(`[SessionTokenService] ${result}`);
  }
}

interface SessionTokenData {
  tenant_id?: string;
  session_id: string;
  task_id?: string;
  branch_id?: string;
  user_id: string;
  created_at: Date;
  expires_at: Date;
  max_uses: number;
  use_count: number;
}

interface VerifiedExecutorToken {
  tenantId?: string;
  sessionId: string;
  taskId: string | null;
  branchId: string | null;
  userId: string;
}

export interface SessionInfo {
  session_id: string;
  task_id?: string;
  branch_id?: string;
  user_id: string;
}

export interface SessionTokenValidationScope {
  tenantId?: string;
  userId?: string;
  sessionId?: string;
  taskId?: string;
  branchId?: string;
}

/** Testable port; production PostgreSQL uses the implementation below. */
export interface SessionTokenAuthorityStore {
  issue(input: ExecutorSessionTokenAuthorityIssue): Promise<void>;
  validateAndConsume(input: ExecutorSessionTokenAuthorityClaim): Promise<SessionInfo | null>;
  revoke(tokenFingerprint: string, tenantId: string): Promise<boolean>;
  revokeSession(sessionId: string, tenantId: string): Promise<number>;
  purgeRetained(cutoff: Date): Promise<number>;
}

class PostgreSQLSessionTokenAuthorityStore implements SessionTokenAuthorityStore {
  constructor(private readonly db: TenantScopeAwareDatabase) {}

  async issue(input: ExecutorSessionTokenAuthorityIssue): Promise<void> {
    await this.withIndependentTenantTransaction(input.tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).issue(input)
    );
  }

  async validateAndConsume(input: ExecutorSessionTokenAuthorityClaim): Promise<SessionInfo | null> {
    const authority = await this.withIndependentTenantTransaction(input.tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).validateAndConsume(input)
    );
    if (!authority) return null;
    return {
      session_id: authority.sessionId,
      ...(authority.taskId ? { task_id: authority.taskId } : {}),
      ...(authority.branchId ? { branch_id: authority.branchId } : {}),
      user_id: authority.userId,
    };
  }

  async revoke(tokenFingerprint: string, tenantId: string): Promise<boolean> {
    return this.withIndependentTenantTransaction(tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).revoke(tokenFingerprint, tenantId)
    );
  }

  async revokeSession(sessionId: string, tenantId: string): Promise<number> {
    return this.withIndependentTenantTransaction(tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).revokeSession(sessionId, tenantId)
    );
  }

  async purgeRetained(cutoff: Date): Promise<number> {
    const tenantIds = await runWithoutTenantContext(() =>
      runWithoutTenantDatabaseScope(() =>
        runWithSystemDatabaseScope(
          this.db,
          'executor session token authority retention cleanup',
          (systemDb) =>
            new ExecutorSessionTokenAuthorityRepository(systemDb).findPurgeTenantIds(
              cutoff,
              CLEANUP_TENANT_LIMIT
            ),
          { capability: 'executor_token_maintenance' }
        )
      )
    );
    let purged = 0;
    for (const tenantId of tenantIds) {
      purged += await runWithoutTenantContext(() =>
        runWithoutTenantDatabaseScope(() =>
          runWithTenantDatabaseScope(this.db, tenantId, (scoped) =>
            new ExecutorSessionTokenAuthorityRepository(scoped).purgeRetained(tenantId, cutoff)
          )
        )
      );
    }
    return purged;
  }

  /**
   * Token authority is an authentication boundary, not part of the caller's
   * domain transaction. Commit issuance before an executor can connect and
   * commit bounded-use consumption even if the protected RPC later rolls back.
   */
  private withIndependentTenantTransaction<T>(
    tenantId: string,
    work: (db: TenantScopedDatabase) => Promise<T>
  ): Promise<T> {
    return runWithoutTenantDatabaseScope(() => runWithTenantDatabaseScope(this.db, tenantId, work));
  }
}

export interface SessionTokenServiceDependencies {
  db?: TenantScopeAwareDatabase;
  /** Unit-test seam. Supplying a store selects PostgreSQL authority semantics. */
  authorityStore?: SessionTokenAuthorityStore;
  now?: () => Date;
  startCleanupTimer?: boolean;
}

function fingerprintToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class SessionTokenService {
  private readonly tokens = new Map<string, SessionTokenData>();
  private readonly authorityStore: SessionTokenAuthorityStore | null;
  private readonly now: () => Date;
  private cleanupTimer?: ReturnType<typeof setInterval>;
  private jwtSecret: string | null = null;

  constructor(
    private readonly config: {
      expiration_ms: number; // Default: 86400000 (24 hours)
      max_uses: number; // Default: -1 (unlimited)
    },
    dependencies: SessionTokenServiceDependencies = {}
  ) {
    if (!Number.isFinite(config.expiration_ms) || config.expiration_ms <= 0) {
      throw new Error('SessionTokenService expiration must be positive');
    }
    if (!Number.isInteger(config.max_uses)) {
      throw new Error('SessionTokenService max uses must be an integer');
    }

    this.now = dependencies.now ?? (() => new Date());
    if (dependencies.authorityStore) {
      this.authorityStore = dependencies.authorityStore;
    } else if (dependencies.db && isPostgresDatabaseHandle(dependencies.db)) {
      this.authorityStore = new PostgreSQLSessionTokenAuthorityStore(dependencies.db);
    } else {
      // The composition root always supplies its database. Keep direct
      // standalone/test construction compatible, but never let an explicitly
      // PostgreSQL process silently select the local Map.
      if (!dependencies.db && process.env.AGOR_DB_DIALECT === 'postgresql') {
        throw new Error('SessionTokenService requires its PostgreSQL database authority');
      }
      this.authorityStore = null;
    }

    if (dependencies.startCleanupTimer !== false) this.startCleanupTimer();
  }

  /** Must be called with the same stable secret configured on every daemon. */
  setJwtSecret(secret: string): void {
    this.jwtSecret = secret;
  }

  /** Generate and durably authorize a new executor-session JWT. */
  async generateToken(
    sessionId: string,
    userId: string,
    scope: { taskId?: string; branchId?: string; maxUses?: number } = {}
  ): Promise<string> {
    if (!this.jwtSecret) {
      throw new Error('SessionTokenService: JWT secret not set. Call setJwtSecret() first.');
    }

    const maxUses = scope.maxUses ?? this.config.max_uses;
    if (!Number.isInteger(maxUses)) {
      throw new Error('SessionTokenService max uses must be an integer');
    }

    const now = this.now();
    const expiresAt = new Date(now.getTime() + this.config.expiration_ms);
    const tenantId = getCurrentTenantId();
    if (this.authorityStore && !tenantId) {
      throw new Error('Missing trusted tenant context for executor token issuance');
    }

    const payload = {
      sub: userId,
      type: EXECUTOR_SESSION_TOKEN_TYPE,
      purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
      session_id: sessionId,
      task_id: scope.taskId,
      branch_id: scope.branchId,
      // Ensure two otherwise-identical issuances in the same second produce
      // distinct bearer credentials and authority rows.
      jti: randomUUID(),
      ...(tenantId ? { tenant_id: tenantId } : {}),
      iat: Math.floor(now.getTime() / 1000),
      exp: Math.floor(expiresAt.getTime() / 1000),
      aud: RUNTIME_JWT_AUDIENCE,
      iss: RUNTIME_JWT_ISSUER,
    };

    const token = jwt.sign(payload, this.jwtSecret, { algorithm: 'HS256' });

    if (this.authorityStore) {
      // Issuance fails before the bearer leaves this method if PostgreSQL is
      // unavailable. There is deliberately no local fallback.
      await this.authorityStore.issue({
        tenantId: tenantId as string,
        tokenFingerprint: fingerprintToken(token),
        tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
        sessionId,
        taskId: scope.taskId ?? null,
        branchId: scope.branchId ?? null,
        userId,
        createdAt: now,
        expiresAt,
        maxUses,
      });
    } else {
      // Compatibility boundary: standalone SQLite keeps the original raw-token
      // Map, including its process-local revocation and use-count semantics.
      this.tokens.set(token, {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        session_id: sessionId,
        task_id: scope.taskId,
        branch_id: scope.branchId,
        user_id: userId,
        created_at: now,
        expires_at: expiresAt,
        max_uses: maxUses,
        use_count: 0,
      });
    }

    sessionTokenDebug('issued');
    return token;
  }

  /**
   * Verify signature/expiry and atomically apply authority/use policy.
   *
   * Bounded tokens consume one use per successful validation, preserving the
   * existing per-protected-RPC contract. Runtime executor tokens explicitly
   * use maxUses=-1, so initial authentication and reconnects do not consume a
   * bounded connection allowance.
   */
  async validateToken(
    token: string,
    expected: SessionTokenValidationScope = {}
  ): Promise<SessionInfo | null> {
    const claims = this.verifyToken(token, false);
    if (!claims) {
      sessionTokenDebug('rejected_invalid_signature_or_claims');
      return null;
    }

    const ambientTenantId = getCurrentTenantId();
    if (
      (expected.tenantId && ambientTenantId && expected.tenantId !== ambientTenantId) ||
      (expected.tenantId && claims.tenantId !== expected.tenantId) ||
      (ambientTenantId && claims.tenantId !== ambientTenantId) ||
      (expected.userId && claims.userId !== expected.userId) ||
      (expected.sessionId && claims.sessionId !== expected.sessionId) ||
      (expected.taskId && claims.taskId !== expected.taskId) ||
      (expected.branchId && claims.branchId !== expected.branchId)
    ) {
      sessionTokenDebug('rejected_scope_mismatch');
      return null;
    }

    if (this.authorityStore) {
      const trustedTenantId = expected.tenantId ?? ambientTenantId ?? claims.tenantId;
      if (!trustedTenantId || claims.tenantId !== trustedTenantId) {
        sessionTokenDebug('rejected_missing_tenant');
        return null;
      }
      // Database errors propagate: authentication fails closed and never falls
      // back to the local Map in PostgreSQL mode.
      const sessionInfo = await this.authorityStore.validateAndConsume({
        tenantId: trustedTenantId,
        tokenFingerprint: fingerprintToken(token),
        tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose: EXECUTOR_SESSION_TOKEN_PURPOSE,
        sessionId: claims.sessionId,
        taskId: claims.taskId,
        branchId: claims.branchId,
        userId: claims.userId,
      });
      sessionTokenDebug(sessionInfo ? 'validated_shared' : 'rejected_by_shared_authority');
      return sessionInfo;
    }

    const data = this.tokens.get(token);
    if (!data) {
      sessionTokenDebug('rejected_by_local_authority');
      return null;
    }
    if (this.now() >= data.expires_at) {
      this.tokens.delete(token);
      sessionTokenDebug('rejected_expired');
      return null;
    }
    if (
      data.tenant_id !== claims.tenantId ||
      data.session_id !== claims.sessionId ||
      (data.task_id ?? null) !== claims.taskId ||
      (data.branch_id ?? null) !== claims.branchId ||
      data.user_id !== claims.userId
    ) {
      sessionTokenDebug('rejected_local_claim_mismatch');
      return null;
    }
    if (data.max_uses > 0 && data.use_count >= data.max_uses) {
      this.tokens.delete(token);
      sessionTokenDebug('rejected_max_uses');
      return null;
    }
    if (data.max_uses > 0) data.use_count += 1;

    sessionTokenDebug('validated_local');
    return {
      session_id: data.session_id,
      ...(data.task_id ? { task_id: data.task_id } : {}),
      ...(data.branch_id ? { branch_id: data.branch_id } : {}),
      user_id: data.user_id,
    };
  }

  /** Revoke one exact bearer. PostgreSQL failures are surfaced to the caller. */
  async revokeToken(token: string): Promise<boolean> {
    if (!this.authorityStore) return this.tokens.delete(token);

    const claims = this.verifyToken(token, true);
    if (!claims?.tenantId) return false;
    const ambientTenantId = getCurrentTenantId();
    if (ambientTenantId && ambientTenantId !== claims.tenantId) return false;
    return this.authorityStore.revoke(fingerprintToken(token), claims.tenantId);
  }

  /** Revoke all token authorities for a logical/synthetic session in one tenant. */
  async revokeSessionTokens(sessionId: string): Promise<number> {
    if (this.authorityStore) {
      const tenantId = getCurrentTenantId();
      if (!tenantId) throw new Error('Missing trusted tenant context for session token revocation');
      return this.authorityStore.revokeSession(sessionId, tenantId);
    }

    let count = 0;
    for (const [token, data] of this.tokens.entries()) {
      if (data.session_id === sessionId) {
        this.tokens.delete(token);
        count += 1;
      }
    }
    return count;
  }

  /** Process-local diagnostic retained for compatibility; PostgreSQL returns 0. */
  getActiveTokenCount(): number {
    return this.tokens.size;
  }

  /** Run one local expiry or PostgreSQL tombstone-retention pass. */
  async cleanupExpiredTokens(now = this.now()): Promise<number> {
    if (this.authorityStore) {
      const cutoff = new Date(now.getTime() - EXECUTOR_SESSION_TOKEN_AUTHORITY_RETENTION_MS);
      return this.authorityStore.purgeRetained(cutoff);
    }

    let count = 0;
    for (const [token, data] of this.tokens.entries()) {
      if (now >= data.expires_at) {
        this.tokens.delete(token);
        count += 1;
      }
    }
    return count;
  }

  /** Stop the maintenance timer (primarily for bounded tests/shutdown wiring). */
  close(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = undefined;
  }

  private verifyToken(token: string, ignoreExpiration: boolean): VerifiedExecutorToken | null {
    if (!this.jwtSecret) return null;
    try {
      const payload = jwt.verify(token, this.jwtSecret, {
        algorithms: ['HS256'],
        audience: RUNTIME_JWT_AUDIENCE,
        issuer: RUNTIME_JWT_ISSUER,
        ignoreExpiration,
        clockTimestamp: Math.floor(this.now().getTime() / 1000),
      });
      if (typeof payload === 'string' || !isExecutorSessionTokenPayload(payload)) return null;

      const sessionId = getExecutorSessionTokenSessionId(payload);
      const userId = payload.sub;
      const tenantId = payload.tenant_id;
      const taskId = payload.task_id;
      const branchId = payload.branch_id;
      if (
        typeof sessionId !== 'string' ||
        !sessionId ||
        typeof userId !== 'string' ||
        !userId ||
        (tenantId !== undefined && (typeof tenantId !== 'string' || !tenantId)) ||
        (taskId !== undefined && typeof taskId !== 'string') ||
        (branchId !== undefined && typeof branchId !== 'string')
      ) {
        return null;
      }
      return {
        ...(typeof tenantId === 'string' ? { tenantId } : {}),
        sessionId,
        taskId: taskId ?? null,
        branchId: branchId ?? null,
        userId,
      };
    } catch {
      return null;
    }
  }

  private startCleanupTimer(): void {
    this.cleanupTimer = setInterval(() => {
      void this.cleanupExpiredTokens().catch(() => {
        // Cleanup is retryable and does not participate in authentication.
        // Never log the underlying DB error: it may contain a bound fingerprint.
        console.warn('[SessionTokenService] Authority retention cleanup failed; will retry');
      });
    }, CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref?.();
  }
}
