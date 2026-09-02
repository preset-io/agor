/**
 * SessionTokenService - delegated executor JWT issuance and authority policy.
 *
 * Standalone SQLite preserves the historical process-local authority Map,
 * keyed by a SHA-256 fingerprint so the daemon need not retain raw bearers.
 * PostgreSQL stores only a SHA-256 fingerprint plus tenant/user/resource,
 * expiry, revocation, and use-policy facts. A valid JWT signature is necessary
 * but never sufficient: every authentication must also claim the authority row.
 */

import { createHash, randomUUID } from 'node:crypto';
import {
  type CurrentTaskExecutorSessionTokenAuthority,
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
  EXECUTOR_COMMAND_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_PURPOSE,
  EXECUTOR_SESSION_TOKEN_TYPE,
  type ExecutorSessionTokenRevocation,
  type ExecutorTokenPurpose,
  getExecutorSessionTokenSessionId,
  isExecutorSessionTokenPayload,
} from '../auth/executor-session-token.js';
import { RUNTIME_JWT_AUDIENCE, RUNTIME_JWT_ISSUER } from '../auth/runtime-tokens.js';

const DEBUG_SESSION_TOKENS =
  process.env.AGOR_DEBUG_SESSION_TOKENS === '1' || process.env.DEBUG?.includes('session-token');

const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const CLEANUP_TENANT_LIMIT = 1_000;
export const EXECUTOR_SESSION_TOKEN_AUTHORITY_RETENTION_MS = 24 * 60 * 60 * 1000;

/**
 * Default lifetime for taskless, fire-and-forget executor commands.
 *
 * These credentials delegate the initiating user's normal tenant authority,
 * but have no task lifecycle that can reliably revoke them when a remote
 * launcher exits. Keep that bearer window bounded independently of the longer
 * task-executor session configured by the operator. A caller that owns a
 * stricter server-side command deadline may request that exact bounded window;
 * the configured session-token maximum remains authoritative.
 */
const EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS = 15 * 60 * 1000;

function sessionTokenDebug(result: string): void {
  if (DEBUG_SESSION_TOKENS) {
    // Only a bounded result category is permitted here. Bearers, fingerprints,
    // claims, scopes, and database errors are intentionally omitted.
    console.debug(`[SessionTokenService] ${result}`);
  }
}

interface SessionTokenData {
  tenant_id?: string;
  purpose: ExecutorTokenPurpose;
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
  purpose: ExecutorTokenPurpose;
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
  isCurrent(input: CurrentTaskExecutorSessionTokenAuthority): Promise<boolean>;
  revoke(tokenFingerprint: string, tenantId: string): Promise<boolean>;
  revokeByTask(taskId: string, tenantId: string): Promise<string[]>;
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

  async isCurrent(input: CurrentTaskExecutorSessionTokenAuthority): Promise<boolean> {
    return this.withIndependentTenantTransaction(input.tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).isCurrent(input)
    );
  }

  async revoke(tokenFingerprint: string, tenantId: string): Promise<boolean> {
    return this.withIndependentTenantTransaction(tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).revoke(tokenFingerprint, tenantId)
    );
  }

  async revokeByTask(taskId: string, tenantId: string): Promise<string[]> {
    return this.withIndependentTenantTransaction(tenantId, (scoped) =>
      new ExecutorSessionTokenAuthorityRepository(scoped).revokeByTask(taskId, tenantId)
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
  /** Fence already-authenticated executor sockets after authority commits. */
  onRevoked?: (revocation: ExecutorSessionTokenRevocation) => void | Promise<void>;
}

export function fingerprintExecutorSessionToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

export class SessionTokenService {
  private readonly tokens = new Map<string, SessionTokenData>();
  private readonly authorityStore: SessionTokenAuthorityStore | null;
  private readonly now: () => Date;
  private readonly onRevoked?: SessionTokenServiceDependencies['onRevoked'];
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
    this.onRevoked = dependencies.onRevoked;
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

  /**
   * Issue a bounded delegated-user credential for a taskless executor command.
   * Centralizing this policy prevents individual command dispatchers from
   * silently falling back to the longer task-runtime lifetime.
   *
   * The durable authority schema predates taskless commands, so its historical
   * `session_id` slot carries this opaque command ID. It is never resolved as
   * a Session: only exact command-capability guards interpret it.
   */
  generateCommandToken(
    commandId: string,
    userId: string,
    branchId?: string,
    options: { expirationMs?: number } = {}
  ): Promise<string> {
    if (options.expirationMs !== undefined && options.expirationMs > this.config.expiration_ms) {
      throw new Error(
        `Executor command requires a ${options.expirationMs}ms credential, which exceeds execution.session_token_expiration_ms (${this.config.expiration_ms}ms)`
      );
    }
    return this.generateTokenWithPurpose(
      commandId,
      userId,
      {
        branchId,
        maxUses: -1,
        expirationMs: options.expirationMs ?? EXECUTOR_COMMAND_TOKEN_EXPIRATION_MS,
      },
      EXECUTOR_COMMAND_TOKEN_PURPOSE
    );
  }

  /** Generate and durably authorize a new executor-session JWT. */
  async generateToken(
    sessionId: string,
    userId: string,
    scope: {
      taskId?: string;
      branchId?: string;
      maxUses?: number;
      /** Optional shorter lifetime; never extends the configured maximum. */
      expirationMs?: number;
    } = {}
  ): Promise<string> {
    return this.generateTokenWithPurpose(sessionId, userId, scope, EXECUTOR_SESSION_TOKEN_PURPOSE);
  }

  private async generateTokenWithPurpose(
    sessionId: string,
    userId: string,
    scope: {
      taskId?: string;
      branchId?: string;
      maxUses?: number;
      expirationMs?: number;
    },
    purpose: ExecutorTokenPurpose
  ): Promise<string> {
    if (!this.jwtSecret) {
      throw new Error('SessionTokenService: JWT secret not set. Call setJwtSecret() first.');
    }

    const maxUses = scope.maxUses ?? this.config.max_uses;
    if (!Number.isInteger(maxUses)) {
      throw new Error('SessionTokenService max uses must be an integer');
    }
    if (
      scope.expirationMs !== undefined &&
      (!Number.isFinite(scope.expirationMs) || scope.expirationMs <= 0)
    ) {
      throw new Error('SessionTokenService token expiration must be positive');
    }

    const now = this.now();
    const expirationMs = Math.min(
      scope.expirationMs ?? this.config.expiration_ms,
      this.config.expiration_ms
    );
    const expiresAt = new Date(now.getTime() + expirationMs);
    const tenantId = getCurrentTenantId();
    if (this.authorityStore && !tenantId) {
      throw new Error('Missing trusted tenant context for executor token issuance');
    }

    const payload = {
      sub: userId,
      type: EXECUTOR_SESSION_TOKEN_TYPE,
      purpose,
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
        tokenFingerprint: fingerprintExecutorSessionToken(token),
        tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose,
        sessionId,
        taskId: scope.taskId ?? null,
        branchId: scope.branchId ?? null,
        userId,
        createdAt: now,
        expiresAt,
        maxUses,
      });
    } else {
      // Compatibility boundary: standalone SQLite keeps process-local
      // revocation/use-count semantics, but retains only the fingerprint.
      this.tokens.set(fingerprintExecutorSessionToken(token), {
        ...(tenantId ? { tenant_id: tenantId } : {}),
        purpose,
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
        tokenFingerprint: fingerprintExecutorSessionToken(token),
        tokenType: EXECUTOR_SESSION_TOKEN_TYPE,
        purpose: claims.purpose,
        sessionId: claims.sessionId,
        taskId: claims.taskId,
        branchId: claims.branchId,
        userId: claims.userId,
      });
      sessionTokenDebug(sessionInfo ? 'validated_shared' : 'rejected_by_shared_authority');
      return sessionInfo;
    }

    const tokenFingerprint = fingerprintExecutorSessionToken(token);
    const data = this.tokens.get(tokenFingerprint);
    if (!data) {
      sessionTokenDebug('rejected_by_local_authority');
      return null;
    }
    if (this.now() >= data.expires_at) {
      this.tokens.delete(tokenFingerprint);
      sessionTokenDebug('rejected_expired');
      return null;
    }
    if (
      data.tenant_id !== claims.tenantId ||
      data.purpose !== claims.purpose ||
      data.session_id !== claims.sessionId ||
      (data.task_id ?? null) !== claims.taskId ||
      (data.branch_id ?? null) !== claims.branchId ||
      data.user_id !== claims.userId
    ) {
      sessionTokenDebug('rejected_local_claim_mismatch');
      return null;
    }
    if (data.max_uses > 0 && data.use_count >= data.max_uses) {
      this.tokens.delete(tokenFingerprint);
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

  /**
   * Check the current authority behind an already-authenticated Task bearer.
   * Callers supply only the server-derived fingerprint and verified claims.
   */
  async isTaskTokenAuthorityCurrent(
    input: CurrentTaskExecutorSessionTokenAuthority
  ): Promise<boolean> {
    if (this.authorityStore) return this.authorityStore.isCurrent(input);

    const data = this.tokens.get(input.tokenFingerprint);
    if (!data) return false;
    if (this.now() >= data.expires_at) {
      this.tokens.delete(input.tokenFingerprint);
      return false;
    }
    return (
      data.tenant_id === input.tenantId &&
      data.purpose === EXECUTOR_SESSION_TOKEN_PURPOSE &&
      data.session_id === input.sessionId &&
      data.task_id === input.taskId &&
      data.branch_id === input.branchId &&
      data.user_id === input.userId
    );
  }

  /** Revoke one exact bearer. PostgreSQL failures are surfaced to the caller. */
  async revokeToken(token: string): Promise<boolean> {
    if (!this.authorityStore) {
      const tokenFingerprint = fingerprintExecutorSessionToken(token);
      const existing = this.tokens.get(tokenFingerprint);
      const revoked = this.tokens.delete(tokenFingerprint);
      if (revoked) {
        await this.onRevoked?.({
          ...(existing?.tenant_id ? { tenantId: existing.tenant_id } : {}),
          tokenFingerprint,
        });
      }
      return revoked;
    }

    const claims = this.verifyToken(token, true);
    if (!claims?.tenantId) return false;
    const ambientTenantId = getCurrentTenantId();
    if (ambientTenantId && ambientTenantId !== claims.tenantId) return false;
    const tokenFingerprint = fingerprintExecutorSessionToken(token);
    const revoked = await this.authorityStore.revoke(tokenFingerprint, claims.tenantId);
    if (revoked) {
      await this.onRevoked?.({
        tenantId: claims.tenantId,
        tokenFingerprint,
      });
    }
    return revoked;
  }

  /**
   * Revoke all delegated-user credentials for one completed Task.
   *
   * Remote launcher processes do not share the daemon child's `onExit`
   * lifecycle. Task terminality is the durable boundary common to local and
   * remote execution, so credential retirement belongs here rather than in a
   * process-exit callback.
   */
  async revokeTaskTokens(taskId: string): Promise<number> {
    if (!taskId) throw new Error('Executor task token revocation requires a task ID');

    if (!this.authorityStore) {
      const revoked: Array<{ tokenFingerprint: string; data: SessionTokenData }> = [];
      for (const [tokenFingerprint, data] of this.tokens.entries()) {
        if (data.task_id !== taskId) continue;
        this.tokens.delete(tokenFingerprint);
        revoked.push({ tokenFingerprint, data });
      }
      for (const { tokenFingerprint, data } of revoked) {
        await this.onRevoked?.({
          ...(data.tenant_id ? { tenantId: data.tenant_id } : {}),
          tokenFingerprint,
        });
      }
      return revoked.length;
    }

    const tenantId = getCurrentTenantId();
    if (!tenantId) throw new Error('Missing trusted tenant context for executor task revocation');
    const fingerprints = await this.authorityStore.revokeByTask(taskId, tenantId);
    for (const tokenFingerprint of fingerprints) {
      await this.onRevoked?.({ tenantId, tokenFingerprint });
    }
    return fingerprints.length;
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
    for (const [tokenFingerprint, data] of this.tokens.entries()) {
      if (now >= data.expires_at) {
        this.tokens.delete(tokenFingerprint);
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
        purpose: payload.purpose,
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

/**
 * Resolve the daemon-owned issuer at the composition boundary and mint a
 * bounded initiating-user credential for a taskless executor command.
 *
 * The Feathers application type is shared with clients and intentionally does
 * not expose daemon-private singletons. Keep that one runtime projection here
 * rather than duplicating casts and fallback token issuers across services.
 */
export async function issueExecutorCommandToken(
  app: object,
  commandId: string,
  userId: string,
  branchId?: string,
  options?: { expirationMs?: number }
): Promise<string> {
  const service = (app as { sessionTokenService?: SessionTokenService }).sessionTokenService;
  if (!service) throw new Error('Session token service unavailable');
  return options
    ? service.generateCommandToken(commandId, userId, branchId, options)
    : service.generateCommandToken(commandId, userId, branchId);
}
