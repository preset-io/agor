/**
 * Behavioral tests for OAuth authorization helpers.
 *
 * These tests cover two security-critical behaviors previously only verified
 * via source-text assertions:
 *
 * 1. Tenant-scoped OAuth callback persistence: token writes must be wrapped in
 *    `runWithTenantDatabaseScope` when the pending flow carries a `tenantId`,
 *    so cross-tenant token pollution is impossible under multi-tenancy.
 *
 * 2. forUserId privilege gate: regular authenticated users and executor-session
 *    token holders who pass `?forUserId=<victim>` must be silently redirected
 *    to their own user ID; only service-account callers may specify a different
 *    user ID.
 */

import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { runWithTenantDatabaseScope } from '@agor/core/db';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveForUserIdWithGate, runInOAuthTenantScope } from './oauth-auth-helpers';

// Mock only runWithTenantDatabaseScope; preserve all other @agor/core/db exports
// so downstream code that imports types from the same path still resolves.
vi.mock('@agor/core/db', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/db')>();
  return {
    ...actual,
    runWithTenantDatabaseScope: vi.fn(),
  };
});

// ============================================================================
// runInOAuthTenantScope — tenant-scoped DB access during OAuth persistence
// ============================================================================

describe('runInOAuthTenantScope', () => {
  const mockDb = {} as TenantScopeAwareDatabase;

  beforeEach(() => {
    vi.mocked(runWithTenantDatabaseScope).mockClear();
    vi.mocked(runWithTenantDatabaseScope).mockImplementation((_db, _tenantId, work) => work());
  });

  it('invokes runWithTenantDatabaseScope with the captured tenant ID', async () => {
    const work = vi.fn().mockResolvedValue('token-written');

    await runInOAuthTenantScope(mockDb, 'tenant-abc', work);

    expect(runWithTenantDatabaseScope).toHaveBeenCalledWith(mockDb, 'tenant-abc', work);
    expect(work).toHaveBeenCalled();
  });

  it('would fail if the tenant scope is not applied — skipping it changes which DB receives the write', async () => {
    // This test fails if runInOAuthTenantScope stops calling runWithTenantDatabaseScope,
    // i.e. if a refactor accidentally drops the tenant wrapping.
    const work = vi.fn().mockResolvedValue('ok');

    await runInOAuthTenantScope(mockDb, 'tenant-xyz', work);

    // The tenant ID passed to the scope must match the one on the pending flow.
    expect(runWithTenantDatabaseScope).toHaveBeenCalledTimes(1);
    const [, tenantArg] = vi.mocked(runWithTenantDatabaseScope).mock.calls[0];
    expect(tenantArg).toBe('tenant-xyz');
  });

  it('skips the scope wrapper when tenantId is undefined — global DB context', async () => {
    const work = vi.fn().mockResolvedValue('ok');

    await runInOAuthTenantScope(mockDb, undefined, work);

    expect(runWithTenantDatabaseScope).not.toHaveBeenCalled();
    expect(work).toHaveBeenCalled();
  });

  it('propagates the work result through the tenant scope unchanged', async () => {
    const expectedResult = { access_token: 'tok123' };
    const work = vi.fn().mockResolvedValue(expectedResult);

    const result = await runInOAuthTenantScope(mockDb, 'tenant-abc', work);

    expect(result).toEqual(expectedResult);
  });
});

// ============================================================================
// resolveForUserIdWithGate — forUserId privilege escalation prevention
// ============================================================================

describe('resolveForUserIdWithGate', () => {
  it('returns callerUserId for a regular authenticated user even when forUserId is set', () => {
    // A regular user passing ?forUserId=<victim> must be silently redirected to
    // their own user ID. Without this gate any authenticated member could fetch
    // another user's OAuth token.
    const result = resolveForUserIdWithGate({
      queryForUserId: 'victim-user-id',
      isServiceAccount: false,
      authPayloadType: 'local-jwt',
      callerUserId: 'caller-user-id',
    });

    expect(result).toBe('caller-user-id');
    expect(result).not.toBe('victim-user-id');
  });

  it('returns callerUserId when isServiceAccount is undefined (unauthenticated-ish context)', () => {
    const result = resolveForUserIdWithGate({
      queryForUserId: 'victim-user-id',
      isServiceAccount: undefined,
      authPayloadType: undefined,
      callerUserId: 'caller-user-id',
    });

    expect(result).toBe('caller-user-id');
  });

  it('allows forUserId for service-account callers', () => {
    // Executor service accounts need to resolve OAuth tokens for the task's
    // owning user; this is the intended use-case for forUserId.
    const result = resolveForUserIdWithGate({
      queryForUserId: 'task-owner-id',
      isServiceAccount: true,
      authPayloadType: 'internal',
      callerUserId: 'executor-account-id',
    });

    expect(result).toBe('task-owner-id');
  });

  it('preserves forUserId for executor-session token holders when it matches the caller', () => {
    // Executors authenticating with session tokens (authPayloadType === 'executor-session')
    // must be able to request the authenticated task-creator's per-user OAuth tokens.
    const result = resolveForUserIdWithGate({
      queryForUserId: 'task-creator-id',
      isServiceAccount: false,
      authPayloadType: 'executor-session',
      callerUserId: 'task-creator-id',
    });

    expect(result).toBe('task-creator-id');
  });

  it('falls back to callerUserId for executor-session token holders when forUserId differs', () => {
    // Executor-session JWTs authenticate as the token subject. A compromised
    // executor must not be able to choose a different user's OAuth token by
    // passing ?forUserId=<victim>.
    const result = resolveForUserIdWithGate({
      queryForUserId: 'victim-user-id',
      isServiceAccount: false,
      authPayloadType: 'executor-session',
      callerUserId: 'task-creator-id',
    });

    expect(result).toBe('task-creator-id');
    expect(result).not.toBe('victim-user-id');
  });

  it('falls back to callerUserId when forUserId is not set, even for service accounts', () => {
    // No forUserId query param → always use the caller's own ID, regardless
    // of whether they could have used an explicit one.
    const result = resolveForUserIdWithGate({
      queryForUserId: undefined,
      isServiceAccount: true,
      authPayloadType: 'executor-session',
      callerUserId: 'caller-user-id',
    });

    expect(result).toBe('caller-user-id');
  });

  it('returns undefined when no user ID is available at all', () => {
    const result = resolveForUserIdWithGate({
      queryForUserId: undefined,
      isServiceAccount: false,
      authPayloadType: undefined,
      callerUserId: undefined,
    });

    expect(result).toBeUndefined();
  });
});
