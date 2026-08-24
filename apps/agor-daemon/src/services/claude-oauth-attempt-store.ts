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
  /** Rebuilt from the verifier + state whenever a status read needs it. */
  buildVerificationUrl: (verifier: string, state: string) => string;
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
   * Is this claim still the live one? Checked immediately before the credential
   * write AND again before the user-method mutation, because a logout or a
   * replacement attempt can land between those two steps.
   */
  isClaimLive(ctx: ClaudeOAuthAttemptContext, claim: ClaudeOAuthExchangeClaim): Promise<boolean>;
  finish(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim,
    outcome: ClaudeOAuthFinishOutcome
  ): Promise<void>;
  /** Invalidate any live attempt — logout, or another auth-relevant change. */
  invalidate(ctx: ClaudeOAuthAttemptContext, failureCode: string): Promise<void>;
  /**
   * Serialize the final credential-file/user mutation with logout on this
   * daemon. Constrained HA remains gated until this local guard is replaced by
   * the shared generation-fenced credential coordinator.
   */
  withCredentialMutation<T>(ctx: ClaudeOAuthAttemptContext, work: () => Promise<T>): Promise<T>;
}

class InProcessCredentialMutationQueue {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await work();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }
}

/** How long a finished attempt stays queryable before eviction. */
const TERMINAL_ATTEMPT_TTL_MS = 60 * 60 * 1000;
/** How long an attempt keeps its verifier/state before it must be restarted. */
export const ATTEMPT_LIFETIME_MS = 10 * 60 * 1000;

function phaseOf(status: string): ClaudeOAuthPhase {
  switch (status) {
    case 'pending':
      return 'awaiting_code';
    case 'exchanging':
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
    case 'exchange_owner_lost':
      return 'Sign-in could not be completed and the code may be used up — start over to get a fresh link.';
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
    this.expireAndPrune();
    // Invalidate the prior attempt up front so an in-flight submit of the old
    // code cannot clobber this fresh one when it lands.
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
      cancelled: false,
    });
    return { attemptId, verificationUrl, expiresAtMs };
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
      },
    };
  }

  async isClaimLive(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim
  ): Promise<boolean> {
    return this.live(ctx, claim) !== null;
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
    const attempt = this.attempts.get(this.key(ctx));
    if (!attempt) return;
    attempt.cancelled = true;
    if (attempt.phase === 'awaiting_code' || attempt.phase === 'exchanging') {
      this.settle(attempt, 'error', hintForFailureCode(failureCode));
    }
  }

  withCredentialMutation<T>(ctx: ClaudeOAuthAttemptContext, work: () => Promise<T>): Promise<T> {
    return this.credentialMutations.run(this.key(ctx), work);
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
  private readonly credentialMutations = new InProcessCredentialMutationQueue();

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

  async isClaimLive(
    ctx: ClaudeOAuthAttemptContext,
    claim: ClaudeOAuthExchangeClaim
  ): Promise<boolean> {
    const record = await this.authority.readLiveClaim(
      ctx.tenantId,
      claim.attemptId as ClaudeOAuthAttemptID,
      claim.claimId
    );
    return record !== null;
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

  withCredentialMutation<T>(ctx: ClaudeOAuthAttemptContext, work: () => Promise<T>): Promise<T> {
    return this.credentialMutations.run(`${ctx.tenantId}:${ctx.userId}`, work);
  }
}
