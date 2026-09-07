/**
 * Where a Claude OAuth sign-in attempt lives between the two `create` calls.
 *
 * The flow is inherently two-phase — start issues a PKCE verifier and state,
 * then a later request pastes the code back — so something must hold the
 * verifier in between. A process-local Map is correct for a single daemon and
 * wrong the moment a second replica can answer the second request.
 *
 * Two implementations behind one interface:
 * - {@link InMemoryClaudeOAuthAttemptStore} — the original process-local
 *   behavior, used by standalone SQLite deployments. Unchanged semantics.
 * - {@link DurableClaudeOAuthAttemptStore} — PostgreSQL rows with sealed PKCE
 *   material, a per-user generation, and a one-shot exchange claim, so any
 *   replica can finish an attempt any other replica started.
 *
 * SECURITY CONTRACT (both implementations): the verifier and raw state are
 * held only to complete the exchange. They never appear in a log line or any
 * agent/LLM context. The durable store seals the verifier in an AES-256-GCM
 * envelope AAD-bound to the row and persists only a SHA-256 fingerprint of
 * state. Raw state remains browser/request material and is never stored.
 */

import { timingSafeEqual } from 'node:crypto';
import type {
  ClaudeOAuthAttemptID,
  ClaudeOAuthPhase,
  ClaudeOAuthStatus,
  UserID,
} from '@agor/core/types';
import type { ClaudeOAuthAttemptAuthority } from './claude-oauth-attempt-authority.js';

export interface ClaudeOAuthAttemptContext {
  tenantId: string;
  userId: UserID;
}

export interface ClaudeOAuthStartInput {
  verifier: string;
  state: string;
  delegatedHomeKey: string | null;
  /** Canonical exact-user `.claude` directory fixed at attempt start. */
  claudeConfigDir?: string;
  /** Rebuilt from the verifier + state whenever a status read needs it. */
  buildVerificationUrl: (verifier: string, state: string) => string;
  /** Recheck the captured route after acquiring the credential authority. */
  validateRoute?: () => Promise<boolean>;
}

export interface ClaudeOAuthStarted {
  attemptId: string;
  verificationUrl: string;
  expiresAtMs: number;
}

/**
 * Proof that this caller — and no other replica or request — owns the exchange.
 * Carries the material needed to finish, so the caller never re-reads secrets.
 */
export interface ClaudeOAuthExchangeClaim {
  attemptId: string;
  claimId: string;
  verifier: string;
  state: string;
  delegatedHomeKey: string | null;
  claudeConfigDir?: string;
}

export type ClaudeOAuthClaimResult =
  | { outcome: 'claimed'; claim: ClaudeOAuthExchangeClaim }
  /** No live attempt, or it is no longer accepting a code. */
  | { outcome: 'not_pending' }
  /** Another request already reserved this attempt's single exchange. */
  | { outcome: 'already_claimed' }
  | { outcome: 'expired' }
  | { outcome: 'state_mismatch' };

export type ClaudeOAuthFinishOutcome =
  | { status: 'succeeded'; subscriptionType?: string }
  | { status: 'failed'; failureCode: string; hint: string }
  | { status: 'ambiguous'; failureCode: string; hint: string };

export interface ClaudeOAuthAttemptStore {
  start(ctx: ClaudeOAuthAttemptContext, input: ClaudeOAuthStartInput): Promise<ClaudeOAuthStarted>;
  status(ctx: ClaudeOAuthAttemptContext, attemptId?: string): Promise<ClaudeOAuthStatus>;
  claimForExchange(
    ctx: ClaudeOAuthAttemptContext,
    attemptId: string | undefined,
    state: string
  ): Promise<ClaudeOAuthClaimResult>;
  /**
   * Serialize and generation-fence final credential + user-method mutation.
   * The durable implementation holds the tenant/user advisory lock and exact
   * claim predicate through the daemon-contained filesystem writer, user patch,
   * and terminal CAS. Provider I/O has already completed before this begins.
   */
  finalize<T>(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    work: (generation?: number) => Promise<{ value: T; subscriptionType?: string }>
  ): Promise<{ outcome: 'committed'; value: T } | { outcome: 'stale' }>;
  finish(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    outcome: ClaudeOAuthFinishOutcome
  ): Promise<void>;
  /** Invalidate any live attempt — logout, or another auth-relevant change. */
  invalidate(ctx: ClaudeOAuthAttemptContext, failureCode: string): Promise<void>;
  /** Serialize logout/other credential decisions against OAuth completion. */
  runCredentialMutation<T>(
    ctx: ClaudeOAuthAttemptContext,
    reason: 'signed_out' | 'credentials_changed',
    work: (generation?: number) => Promise<T>
  ): Promise<T>;
  /** Serialize a daemon-owned runtime refresh without invalidating a newer login attempt. */
  runCredentialRefresh<T>(
    ctx: ClaudeOAuthAttemptContext,
    work: (generation?: number) => Promise<T>
  ): Promise<T>;
  /** Read and revalidate one credential route while holding writer authority. */
  runCredentialResolution<T>(ctx: ClaudeOAuthAttemptContext, work: () => Promise<T>): Promise<T>;
  /** Acquire the same authority for a users-service route/source mutation. */
  lockExternalUserMutation(tenantId: string, userId: UserID): Promise<(() => Promise<void>) | void>;
  /** Invalidate and generation-fence while the external caller retains that authority. */
  completeExternalUserMutation(
    tenantId: string,
    userId: UserID,
    work: (generation?: number) => Promise<void>,
    reason?: 'credentials_changed' | 'execution_home_changed' | 'user_removed'
  ): Promise<void>;
}

class InProcessCredentialMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async acquire(key: string): Promise<() => Promise<void>> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    };
  }

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await work();
    } finally {
      await release();
    }
  }
}

const STANDALONE_CLAUDE_CREDENTIAL_HOME = 'standalone-claude-credential-home';

/** How long a finished attempt stays queryable before eviction. */
const TERMINAL_ATTEMPT_TTL_MS = 60 * 60 * 1000;
/** How long an attempt keeps its verifier/state before it must be restarted. */
export const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

function phaseOf(status: string): ClaudeOAuthPhase {
  switch (status) {
    case 'pending':
      return 'awaiting_code';
    case 'exchanging':
    case 'persisting':
      return 'exchanging';
    case 'succeeded':
      return 'success';
    case 'expired':
      return 'expired';
    default:
      return 'error';
  }
}

/** User-facing text for a terminal durable failure code. */
function hintForFailureCode(failureCode: string | null): string | undefined {
  switch (failureCode) {
    case 'authorization_timed_out':
      return 'The sign-in link expired — start over to get a fresh one.';
    case 'superseded_by_newer_attempt':
      return 'A newer sign-in replaced this one.';
    case 'signed_out':
      return 'The Claude login was removed — start over to sign in again.';
    case 'credentials_changed':
      return 'A newer Claude authentication choice replaced this sign-in.';
    case 'execution_home_changed':
      return 'The execution home changed — start over to save the login in the new home.';
    case 'user_removed':
      return 'The account was removed while Claude sign-in was in progress.';
    case 'exchange_owner_lost':
      return 'Sign-in could not be completed and the code may be used up — start over to get a fresh link.';
    case 'provider_rejected_code':
      return 'Claude rejected this authorization code — start over to get a fresh link.';
    case 'exchange_failed':
      return 'Sign-in could not be completed and the code may be used up — start over to get a fresh link.';
    case 'credential_persistence_ambiguous':
      return 'Claude sign-in completed, but saving the login could not be confirmed — start over.';
    default:
      return undefined;
  }
}

interface MemoryAttempt {
  attemptId: string;
  phase: ClaudeOAuthPhase;
  verifier: string;
  state: string;
  verificationUrl: string;
  expiresAtMs: number;
  claimId: string | null;
  delegatedHomeKey: string | null;
  claudeConfigDir?: string;
  subscriptionType?: string;
  hint?: string;
  finishedAtMs?: number;
  cancelled: boolean;
}

/**
 * Process-local attempts, one in flight per user. This is the behavior the
 * feature shipped with; a daemon restart discards attempts and the user asks
 * for a fresh link.
 */
export class InMemoryClaudeOAuthAttemptStore implements ClaudeOAuthAttemptStore {
  private readonly attempts = new Map<string, MemoryAttempt>();
  private readonly credentialMutations = new InProcessCredentialMutationQueue();
  private sequence = 0;

  private key(ctx: ClaudeOAuthAttemptContext): string {
    return `${ctx.tenantId}:${ctx.userId}`;
  }

  /**
   * Expire overdue awaiting-code attempts, then evict long-finished ones.
   * Without the expiry step an abandoned link would report `awaiting_code`
   * forever. `exchanging` attempts are left alone — an in-flight exchange is
   * bounded by the fetch timeout, not this clock.
   */
  private expireAndPrune(): void {
    const now = Date.now();
    const cutoff = now - TERMINAL_ATTEMPT_TTL_MS;
    for (const [key, attempt] of this.attempts) {
      if (attempt.phase === 'awaiting_code' && now >= attempt.expiresAtMs) {
        this.settle(
          attempt,
          'expired',
          'The sign-in link expired — start over to get a fresh one.'
        );
      }
      const terminal = attempt.phase !== 'awaiting_code' && attempt.phase !== 'exchanging';
      if (terminal && (attempt.finishedAtMs ?? 0) < cutoff) this.attempts.delete(key);
    }
  }

  /** Move to a terminal phase and drop secrets promptly. */
  private settle(attempt: MemoryAttempt, phase: ClaudeOAuthPhase, hint?: string): void {
    attempt.phase = phase;
    attempt.finishedAtMs = Date.now();
    attempt.verifier = '';
    attempt.state = '';
    if (hint) attempt.hint = hint;
  }

  private live(ctx: ClaudeOAuthAttemptContext, claim: ClaudeOAuthExchangeClaim) {
    const attempt = this.attempts.get(this.key(ctx));
    if (!attempt || attempt.attemptId !== claim.attemptId) return null;
    if (attempt.cancelled || attempt.claimId !== claim.claimId) return null;
    return attempt;
  }

  private snapshot(attempt: MemoryAttempt | undefined): ClaudeOAuthStatus {
    if (!attempt) return { phase: 'idle' };
    const status: ClaudeOAuthStatus = { phase: attempt.phase, attemptId: attempt.attemptId };
    if (attempt.phase === 'awaiting_code') {
      status.verificationUrl = attempt.verificationUrl;
      status.expiresAt = new Date(attempt.expiresAtMs).toISOString();
    }
    if (attempt.subscriptionType) status.subscriptionType = attempt.subscriptionType;
    if (attempt.hint) status.hint = attempt.hint;
    return status;
  }

  async start(
    ctx: ClaudeOAuthAttemptContext,
    input: ClaudeOAuthStartInput
  ): Promise<ClaudeOAuthStarted> {
    // Standalone/simple mode can route every user to the daemon's one Claude
    // home, so starts participate in the same queue as finalize/logout. This
    // makes "new start wins" linearizable even if the prior submit is already
    // inside its credential write.
    return this.credentialMutations.run(STANDALONE_CLAUDE_CREDENTIAL_HOME, async () => {
      if (input.validateRoute && !(await input.validateRoute())) {
        throw new Error('Credential route changed before sign-in reservation');
      }
      this.expireAndPrune();
      const prior = this.attempts.get(this.key(ctx));
      if (prior) prior.cancelled = true;

      this.sequence += 1;
      const attemptId = `mem-${this.sequence}`;
      const expiresAtMs = Date.now() + ATTEMPT_LIFETIME_MS;
      const verificationUrl = input.buildVerificationUrl(input.verifier, input.state);
      this.attempts.set(this.key(ctx), {
        attemptId,
        phase: 'awaiting_code',
        verifier: input.verifier,
        state: input.state,
        verificationUrl,
        expiresAtMs,
        claimId: null,
        delegatedHomeKey: input.delegatedHomeKey,
        ...(input.claudeConfigDir ? { claudeConfigDir: input.claudeConfigDir } : {}),
        cancelled: false,
      });
      return { attemptId, verificationUrl, expiresAtMs };
    });
  }

  async status(ctx: ClaudeOAuthAttemptContext, attemptId?: string): Promise<ClaudeOAuthStatus> {
    this.expireAndPrune();
    const attempt = this.attempts.get(this.key(ctx));
    if (attemptId && attempt && attempt.attemptId !== attemptId) return { phase: 'idle' };
    return this.snapshot(attempt);
  }

  async claimForExchange(
    ctx: ClaudeOAuthAttemptContext,
    attemptId: string | undefined,
    state: string
  ): Promise<ClaudeOAuthClaimResult> {
    this.expireAndPrune();
    const attempt = this.attempts.get(this.key(ctx));
    if (!attempt || (attemptId && attempt.attemptId !== attemptId)) {
      return { outcome: 'not_pending' };
    }
    if (attempt.phase === 'exchanging') return { outcome: 'already_claimed' };
    if (attempt.phase !== 'awaiting_code') return { outcome: 'not_pending' };
    if (Date.now() >= attempt.expiresAtMs) {
      this.settle(attempt, 'expired', 'The sign-in link expired — start over to get a fresh one.');
      return { outcome: 'expired' };
    }
    // Compare BEFORE reserving, so a wrong-state paste leaves the attempt
    // awaiting a real code instead of burning it.
    if (!timingSafeStringEqual(state, attempt.state)) return { outcome: 'state_mismatch' };

    attempt.phase = 'exchanging';
    attempt.claimId = `claim-${attempt.attemptId}`;
    return {
      outcome: 'claimed',
      claim: {
        attemptId: attempt.attemptId,
        claimId: attempt.claimId,
        verifier: attempt.verifier,
        state: attempt.state,
        delegatedHomeKey: attempt.delegatedHomeKey,
        ...(attempt.claudeConfigDir ? { claudeConfigDir: attempt.claudeConfigDir } : {}),
      },
    };
  }

  async finalize<T>(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    work: (generation?: number) => Promise<{ value: T; subscriptionType?: string }>
  ): Promise<{ outcome: 'committed'; value: T } | { outcome: 'stale' }> {
    return this.credentialMutations.run(STANDALONE_CLAUDE_CREDENTIAL_HOME, async () => {
      const attempt = this.live(ctx, claim);
      if (!attempt) return { outcome: 'stale' as const };
      // Standalone has no detached credential writer: every writer and route
      // mutation shares this process-global queue. Do not advance durable file
      // tombstones here; retained PostgreSQL sequences remain the sole durable
      // generation domain across offline deployment-mode changes.
      const completed = await work(undefined);
      attempt.subscriptionType = completed.subscriptionType;
      this.settle(
        attempt,
        'success',
        completed.subscriptionType
          ? `Signed in with Claude (${completed.subscriptionType}).`
          : 'Signed in with Claude.'
      );
      return { outcome: 'committed' as const, value: completed.value };
    });
  }

  async finish(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    outcome: ClaudeOAuthFinishOutcome
  ): Promise<void> {
    const attempt = this.live(ctx, claim);
    if (!attempt) return;
    if (outcome.status === 'succeeded') {
      attempt.subscriptionType = outcome.subscriptionType;
      this.settle(
        attempt,
        'success',
        outcome.subscriptionType
          ? `Signed in with Claude (${outcome.subscriptionType}).`
          : 'Signed in with Claude.'
      );
      return;
    }
    this.settle(attempt, 'error', outcome.hint);
  }

  async invalidate(ctx: ClaudeOAuthAttemptContext, failureCode: string): Promise<void> {
    const key = this.key(ctx);
    const attempt = this.attempts.get(key);
    if (!attempt) return;
    attempt.cancelled = true;
    if (attempt.phase === 'awaiting_code' || attempt.phase === 'exchanging') {
      this.settle(attempt, 'error', hintForFailureCode(failureCode));
    } else {
      // Logout or another credential choice must not leave a completed OAuth
      // attempt looking current on a later remount/status read.
      this.attempts.delete(key);
    }
  }

  runCredentialMutation<T>(
    ctx: ClaudeOAuthAttemptContext,
    reason: 'signed_out' | 'credentials_changed',
    work: (generation?: number) => Promise<T>
  ): Promise<T> {
    return this.credentialMutations.run(STANDALONE_CLAUDE_CREDENTIAL_HOME, async () => {
      await this.invalidate(ctx, reason);
      return work(undefined);
    });
  }

  runCredentialRefresh<T>(
    _ctx: ClaudeOAuthAttemptContext,
    work: (generation?: number) => Promise<T>
  ): Promise<T> {
    // Standalone refresh shares the same process-global file queue as OAuth,
    // logout, and route changes. It intentionally does not advance the durable
    // HA tombstone retained across an offline deployment-mode transition.
    return this.credentialMutations.run(STANDALONE_CLAUDE_CREDENTIAL_HOME, () => work(undefined));
  }

  runCredentialResolution<T>(_ctx: ClaudeOAuthAttemptContext, work: () => Promise<T>): Promise<T> {
    return this.credentialMutations.run(STANDALONE_CLAUDE_CREDENTIAL_HOME, work);
  }

  lockExternalUserMutation(_tenantId: string, _userId: UserID): Promise<() => Promise<void>> {
    return this.credentialMutations.acquire(STANDALONE_CLAUDE_CREDENTIAL_HOME);
  }

  async completeExternalUserMutation(
    tenantId: string,
    userId: UserID,
    work: (generation?: number) => Promise<void>,
    reason:
      | 'credentials_changed'
      | 'execution_home_changed'
      | 'user_removed' = 'credentials_changed'
  ): Promise<void> {
    const ctx = { tenantId, userId };
    await this.invalidate(ctx, reason);
    await work(undefined);
  }
}

/** Constant-time compare that tolerates unequal lengths. */
function timingSafeStringEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/**
 * PostgreSQL-backed attempts. Any replica can start, read, or finish one; the
 * database owns the generation fence and the one-shot exchange claim.
 */
export class DurableClaudeOAuthAttemptStore implements ClaudeOAuthAttemptStore {
  constructor(private readonly authority: ClaudeOAuthAttemptAuthority) {}

  async start(
    ctx: ClaudeOAuthAttemptContext,
    input: ClaudeOAuthStartInput
  ): Promise<ClaudeOAuthStarted> {
    const attemptId = await this.authority.create({
      tenantId: ctx.tenantId,
      userId: ctx.userId,
      codeVerifier: input.verifier,
      state: input.state,
      delegatedHomeKey: input.delegatedHomeKey,
      ...(input.claudeConfigDir ? { claudeConfigDir: input.claudeConfigDir } : {}),
      ...(input.validateRoute ? { validateRoute: input.validateRoute } : {}),
    });
    const record = await this.authority.getForUser(ctx.tenantId, ctx.userId, attemptId);
    return {
      attemptId,
      verificationUrl: input.buildVerificationUrl(input.verifier, input.state),
      expiresAtMs: record?.expiresAt.getTime() ?? Date.now() + ATTEMPT_LIFETIME_MS,
    };
  }

  async status(ctx: ClaudeOAuthAttemptContext, attemptId?: string): Promise<ClaudeOAuthStatus> {
    const record = attemptId
      ? await this.authority.getForUser(ctx.tenantId, ctx.userId, attemptId as ClaudeOAuthAttemptID)
      : await this.authority.getCurrentForUser(ctx.tenantId, ctx.userId);
    if (!record) return { phase: 'idle' };

    const phase = phaseOf(record.status);
    const status: ClaudeOAuthStatus = { phase, attemptId: record.attemptId };
    if (phase === 'awaiting_code') {
      status.expiresAt = record.expiresAt.toISOString();
    }
    if (record.subscriptionType) status.subscriptionType = record.subscriptionType;
    const hint =
      phase === 'success'
        ? record.subscriptionType
          ? `Signed in with Claude (${record.subscriptionType}).`
          : 'Signed in with Claude.'
        : hintForFailureCode(record.failureCode);
    if (hint) status.hint = hint;
    return status;
  }

  async claimForExchange(
    ctx: ClaudeOAuthAttemptContext,
    attemptId: string | undefined,
    state: string
  ): Promise<ClaudeOAuthClaimResult> {
    const target =
      attemptId ?? (await this.authority.getCurrentForUser(ctx.tenantId, ctx.userId))?.attemptId;
    if (!target) return { outcome: 'not_pending' };

    // One atomic UPDATE decides the winner: the row moves pending -> exchanging
    // only if the state fingerprint matches, it has not expired, and it is
    // still the current generation. Every other replica loses.
    const result = await this.authority.claimForExchange(
      ctx.tenantId,
      ctx.userId,
      target as ClaudeOAuthAttemptID,
      state
    );
    if (result.outcome === 'claimed') {
      const { record, material } = this.authority.openClaim(result.attempt);
      return {
        outcome: 'claimed',
        claim: {
          attemptId: record.attemptId,
          claimId: record.exchangeClaimId!,
          verifier: material.codeVerifier,
          // claimForExchange atomically matched this request's state hash to
          // the row. Carry the request value forward; raw state is not durable
          // material and never needs to be unsealed.
          state,
          delegatedHomeKey: material.delegatedHomeKey,
          ...(material.claudeConfigDir ? { claudeConfigDir: material.claudeConfigDir } : {}),
        },
      };
    }

    const observed = result.attempt;
    if (!observed?.isCurrent) return { outcome: 'not_pending' };
    if (observed.status === 'exchanging') return { outcome: 'already_claimed' };
    if (observed.status === 'expired') return { outcome: 'expired' };
    if (observed.status !== 'pending') return { outcome: 'not_pending' };
    // Still pending and unexpired, so the claim predicate failed on the state
    // fingerprint alone — the paste does not belong to this attempt.
    return { outcome: 'state_mismatch' };
  }

  async finalize<T>(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    work: (generation: number) => Promise<{ value: T; subscriptionType?: string }>
  ): Promise<{ outcome: 'committed'; value: T } | { outcome: 'stale' }> {
    return this.authority.finalize(
      ctx.tenantId,
      ctx.userId,
      claim.attemptId as ClaudeOAuthAttemptID,
      claim.claimId,
      async (_material, credentialGeneration) => work(credentialGeneration)
    );
  }

  async finish(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    outcome: ClaudeOAuthFinishOutcome
  ): Promise<void> {
    const record = await this.authority.readLiveClaim(
      ctx.tenantId,
      claim.attemptId as ClaudeOAuthAttemptID,
      claim.claimId
    );
    if (!record) return;
    await this.authority.finish(
      record,
      outcome.status,
      outcome.status === 'succeeded'
        ? { subscriptionType: outcome.subscriptionType ?? null }
        : { failureCode: outcome.failureCode }
    );
  }

  async invalidate(ctx: ClaudeOAuthAttemptContext, failureCode: string): Promise<void> {
    await this.authority.invalidateForUser(ctx.tenantId, ctx.userId, failureCode);
  }

  runCredentialMutation<T>(
    ctx: ClaudeOAuthAttemptContext,
    reason: 'signed_out' | 'credentials_changed',
    work: (generation: number) => Promise<T>
  ): Promise<T> {
    return this.authority.runCredentialMutation(ctx.tenantId, ctx.userId, reason, work);
  }

  runCredentialRefresh<T>(
    ctx: ClaudeOAuthAttemptContext,
    work: (generation: number) => Promise<T>
  ): Promise<T> {
    return this.authority.runCredentialRefresh(ctx.tenantId, ctx.userId, work);
  }

  runCredentialResolution<T>(ctx: ClaudeOAuthAttemptContext, work: () => Promise<T>): Promise<T> {
    return this.authority.runCredentialResolution(ctx.tenantId, ctx.userId, work);
  }

  lockExternalUserMutation(tenantId: string, userId: UserID): Promise<void> {
    return this.authority.lockExternalUserMutation(tenantId, userId);
  }

  completeExternalUserMutation(
    tenantId: string,
    userId: UserID,
    work: (generation: number) => Promise<void>,
    reason:
      | 'credentials_changed'
      | 'execution_home_changed'
      | 'user_removed' = 'credentials_changed'
  ): Promise<void> {
    return this.authority.completeExternalUserMutation(tenantId, userId, work, reason);
  }
}
