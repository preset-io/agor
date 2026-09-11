/**
 * Branch Authorization Tests
 *
 * Tests for superadmin role, allow_superadmin config flag, and branch RBAC behavior.
 * Covers the security invariants introduced by the superadmin role feature.
 */

import type { BranchRepository } from '@agor/core/db';
import type { Branch, BranchPermissionLevel, HookContext, Session } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  ensureCanPromptInSession,
  hasBranchPermission,
  isSuperAdmin,
  loadBranchFromSession,
  loadSession,
  loadSessionBranch,
  paginateClientSide,
  protectGatewaySourceMetadata,
  resolveBranchPermission,
  resolveSessionContext,
  setSessionUnixUsername,
} from './branch-authorization';

describe('protectGatewaySourceMetadata', () => {
  const context = (
    data: unknown,
    provider: string | null = 'rest',
    method: 'create' | 'patch' = 'patch'
  ) => ({ data, method, params: { provider } }) as HookContext;

  it.each(['create', 'patch'] as const)(
    'rejects external %s writes of gateway provenance',
    (method) => {
      expect(() =>
        protectGatewaySourceMetadata(
          context(
            {
              custom_context: {
                gateway_source: {
                  channel_id: 'channel-1',
                  channel_name: 'general',
                  channel_type: 'slack',
                  thread_id: 'thread-1',
                },
              },
            },
            'rest',
            method
          )
        )
      ).toThrow('gateway_source is server-managed');
    }
  );

  it('allows external user context that omits the reserved key', () => {
    const hook = context({ custom_context: { project: 'agor' } });
    expect(protectGatewaySourceMetadata(hook)).toBe(hook);
  });

  it('rejects clearing the context through a non-object patch', () => {
    expect(() => protectGatewaySourceMetadata(context({ custom_context: null }))).toThrow(
      'custom_context must be an object'
    );
  });

  it('allows trusted gateway service writes', () => {
    const hook = context({ custom_context: { gateway_source: { channel_type: 'slack' } } }, null);
    expect(protectGatewaySourceMetadata(hook)).toBe(hook);
  });
});

/** Minimal branch fixture for permission tests */
function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'wt-test-0001' as Branch['branch_id'],
    repo_id: 'repo-test-0001' as Branch['repo_id'],
    name: 'test-branch',
    branch: 'test-branch',
    path: '/tmp/test',
    others_can: 'view',
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as Branch;
}

const USER_ID = 'user-test-0001' as import('@agor/core/types').UUID;

describe('isSuperAdmin', () => {
  it('returns true for superadmin role', () => {
    expect(isSuperAdmin(ROLES.SUPERADMIN)).toBe(true);
  });

  it('returns true for deprecated owner role (backwards compat)', () => {
    expect(isSuperAdmin('owner')).toBe(true);
  });

  it('returns false for admin role', () => {
    expect(isSuperAdmin(ROLES.ADMIN)).toBe(false);
  });

  it('returns false for member role', () => {
    expect(isSuperAdmin(ROLES.MEMBER)).toBe(false);
  });

  it('returns false for undefined role', () => {
    expect(isSuperAdmin(undefined)).toBe(false);
  });

  describe('when allow_superadmin=false', () => {
    it('returns false even for superadmin role', () => {
      expect(isSuperAdmin(ROLES.SUPERADMIN, false)).toBe(false);
    });

    it('returns false even for owner role', () => {
      expect(isSuperAdmin('owner', false)).toBe(false);
    });
  });
});

describe('hasBranchPermission', () => {
  describe('owner behavior', () => {
    it('owner always has all permission regardless of others_can', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, true, 'all')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, true, 'prompt')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, true, 'view')).toBe(true);
    });
  });

  describe('superadmin behavior', () => {
    it('superadmin has full access to branches with others_can=none', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, false, 'all', ROLES.SUPERADMIN)).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN)).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN)).toBe(true);
    });

    it('superadmin has full access regardless of others_can level', () => {
      for (const othersCan of ['none', 'view', 'session', 'prompt', 'all'] as const) {
        const wt = makeBranch({ others_can: othersCan });
        expect(hasBranchPermission(wt, USER_ID, false, 'all', ROLES.SUPERADMIN)).toBe(true);
      }
    });

    it('deprecated owner role gets same superadmin full access', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, false, 'all', 'owner')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'prompt', 'owner')).toBe(true);
      expect(hasBranchPermission(wt, USER_ID, false, 'view', 'owner')).toBe(true);
    });
  });

  describe('allow_superadmin=false disables bypass', () => {
    it('superadmin denied view on others_can=none when flag disabled', () => {
      const wt = makeBranch({ others_can: 'none' });
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false)).toBe(false);
    });

    it('superadmin treated as regular user when flag disabled', () => {
      const wt = makeBranch({ others_can: 'view' });
      // Repository-resolved Viewer access applies; the global bypass does not.
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false, 'view')).toBe(
        true
      );
      expect(
        hasBranchPermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN, false, 'view')
      ).toBe(false);
    });
  });

  describe('non-owner permission levels', () => {
    it.each<[BranchPermissionLevel, BranchPermissionLevel, boolean]>([
      ['all', 'all', true],
      ['all', 'prompt', true],
      ['all', 'session', true],
      ['all', 'view', true],
      ['prompt', 'prompt', true],
      ['prompt', 'session', true],
      ['prompt', 'view', true],
      ['prompt', 'all', false],
      ['session', 'session', true],
      ['session', 'view', true],
      ['session', 'prompt', false],
      ['session', 'all', false],
      ['view', 'view', true],
      ['view', 'session', false],
      ['view', 'prompt', false],
      ['view', 'all', false],
      ['none', 'view', false],
      ['none', 'session', false],
      ['none', 'prompt', false],
      ['none', 'all', false],
    ])('effective=%s, required=%s → %s', (effective, required, expected) => {
      const wt = makeBranch({ others_can: 'all' });
      expect(hasBranchPermission(wt, USER_ID, false, required, ROLES.MEMBER, true, effective)).toBe(
        expected
      );
    });

    it('ignores an inert legacy others_can value when no normalized result is supplied', () => {
      const wt = makeBranch({ others_can: 'all' });
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.MEMBER)).toBe(false);
    });
  });
});

describe('resolveBranchPermission', () => {
  it('owner resolves to all', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, true)).toBe('all');
  });

  it('superadmin resolves to all on others_can=none', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('all');
  });

  it('superadmin resolves to all regardless of others_can', () => {
    const wt = makeBranch({ others_can: 'prompt' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('all');
  });

  it('member gets the normalized effective level', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER, true, 'prompt')).toBe(
      'prompt'
    );
  });

  it('member fails closed without a normalized effective level', () => {
    const wt = makeBranch({ others_can: 'all' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('none');
  });

  it('member gets normalized Collaborator access', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER, true, 'session')).toBe(
      'session'
    );
  });

  it('superadmin resolves to all even with others_can=session', () => {
    const wt = makeBranch({ others_can: 'session' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.SUPERADMIN)).toBe('all');
  });
});

const OTHER_USER_ID = 'user-other-0002' as import('@agor/core/types').UUID;

/** Minimal HookContext mock for ensureCanPromptInSession tests */
function makeHookContext(overrides: {
  branch: Branch;
  session: Partial<Session>;
  userId: string;
  isOwner?: boolean;
  userRole?: string;
}): HookContext {
  return {
    params: {
      provider: 'rest',
      user: {
        user_id: overrides.userId,
        role: overrides.userRole ?? ROLES.MEMBER,
      },
      branch: overrides.branch,
      session: overrides.session,
      isBranchOwner: overrides.isOwner ?? false,
    },
  } as unknown as HookContext;
}

describe('ensureCanPromptInSession', () => {
  const hookWithAuthority = (
    allowed: boolean,
    denialReason:
      | 'branch_access_required'
      | 'branch_session_sharing_disabled' = 'branch_session_sharing_disabled'
  ) =>
    ensureCanPromptInSession({
      branchRepository: {
        resolveSessionPromptAuthority: vi.fn().mockResolvedValue({
          allowed,
          source: allowed ? 'own_session' : 'denied',
          ...(allowed ? {} : { denial_reason: denialReason }),
        }),
      } as unknown as BranchRepository,
    });

  describe('canonical prompt authority', () => {
    it('allows prompting an authorized own session', async () => {
      const hook = hookWithAuthority(true);
      const wt = makeBranch({ others_can: 'session' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: USER_ID },
        userId: USER_ID,
      });
      await expect(hook(ctx)).resolves.toBe(ctx);
    });

    it('denies prompting another user session when branch sharing is disabled', async () => {
      const hook = hookWithAuthority(false);
      const wt = makeBranch({ others_can: 'session' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      await expect(hook(ctx)).rejects.toThrow(/branch does not allow shared session prompting/i);
    });

    it('allows prompting another user session when canonical authority allows it', async () => {
      const hook = hookWithAuthority(true);
      const wt = makeBranch({ others_can: 'prompt' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      await expect(hook(ctx)).resolves.toBe(ctx);
    });

    it('denies prompting an own session without Collaborator access', async () => {
      const hook = hookWithAuthority(false, 'branch_access_required');
      const wt = makeBranch({ others_can: 'view' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: USER_ID },
        userId: USER_ID,
      });
      await expect(hook(ctx)).rejects.toThrow(/Only Collaborators and Managers/i);
    });

    it('accepts repository-authorized primary-owner access', async () => {
      const hook = hookWithAuthority(true);
      const wt = makeBranch({ others_can: 'none' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
        isOwner: true,
      });
      await expect(hook(ctx)).resolves.toBe(ctx);
    });
  });

  describe('internal calls bypass', () => {
    it('skips check for internal calls (no provider)', async () => {
      const hook = ensureCanPromptInSession();
      const wt = makeBranch({ others_can: 'none' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      // Remove provider to simulate internal call
      ctx.params.provider = undefined;
      await expect(hook(ctx)).resolves.toBe(ctx);
    });
  });
});

describe('request-scoped RBAC loading', () => {
  const branch = makeBranch({ branch_id: 'branch-cache-1' as Branch['branch_id'] });
  const session = {
    session_id: 'session-cache-1',
    branch_id: branch.branch_id,
    created_by: USER_ID,
  } as Session;

  function makeBranchRepo() {
    return {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => false),
      resolveUserPermission: vi.fn(async () => 'session' as BranchPermissionLevel),
    };
  }

  it('reuses a loaded session and branch across RBAC hooks in one request', async () => {
    const sessionRepo = { findById: vi.fn(async () => session) };
    const branchRepo = makeBranchRepo();
    const ctx = {
      path: 'messages',
      method: 'create',
      data: { session_id: session.session_id },
      params: {
        provider: 'rest',
        user: { user_id: USER_ID, role: ROLES.MEMBER },
        sessionId: session.session_id,
      },
    } as unknown as HookContext;

    await loadSession(sessionRepo)(ctx);
    await loadSession(sessionRepo)(ctx);
    await loadBranchFromSession(branchRepo as never)(ctx);
    await loadBranchFromSession(branchRepo as never)(ctx);

    expect(sessionRepo.findById).toHaveBeenCalledTimes(1);
    expect(branchRepo.findById).toHaveBeenCalledTimes(1);
    expect(branchRepo.isOwner).toHaveBeenCalledTimes(1);
    expect(branchRepo.resolveUserPermission).toHaveBeenCalledTimes(1);
  });

  it('canonicalizes and passes the repository-loaded session to the service get()', async () => {
    const sessionRepo = { findById: vi.fn(async () => session) };
    const branchRepo = makeBranchRepo();
    const ctx = {
      path: 'sessions',
      method: 'get',
      id: 'session-c',
      params: {
        provider: 'rest',
        user: { user_id: USER_ID, role: ROLES.MEMBER },
      },
    } as unknown as HookContext;

    await loadSessionBranch(sessionRepo, branchRepo as never)(ctx);

    expect(sessionRepo.findById).toHaveBeenCalledWith('session-c');
    expect(ctx.id).toBe(session.session_id);
    expect(ctx.params.session).toBe(session);
    expect(
      (ctx.params as { _agorPrefetchedRecord?: { record: unknown } })._agorPrefetchedRecord
    ).toMatchObject({
      id: session.session_id,
      idField: 'session_id',
      record: session,
    });
  });

  it('canonicalizes session IDs in the shared session authorization hook', async () => {
    const sessionRepo = { findById: vi.fn(async () => session) };
    const ctx = {
      path: 'sessions',
      method: 'patch',
      id: 'session-c',
      params: {
        provider: 'rest',
        user: { user_id: USER_ID, role: ROLES.MEMBER },
        sessionId: 'session-c',
      },
    } as unknown as HookContext;

    await loadSession(sessionRepo)(ctx);

    expect(ctx.id).toBe(session.session_id);
    expect(
      (ctx.params as { _agorPrefetchedRecord?: { id: string; record: unknown } })
        ._agorPrefetchedRecord
    ).toEqual({ id: session.session_id, idField: 'session_id', record: session });
  });

  // Every id-addressed verb must resolve here. A verb missing from the branch
  // falls through to the `session_id not found` throw, which surfaces as a 500
  // and denies the request for the wrong reason.
  it.each(['get', 'update', 'patch', 'remove'])(
    'resolves id-addressed message %s context from the stored record, not spoofed query',
    async (method) => {
      const existingMessage = {
        message_id: 'message-cache-1',
        session_id: session.session_id,
      };
      const ctx = {
        path: 'messages',
        method,
        id: existingMessage.message_id,
        params: {
          provider: 'rest',
          query: { session_id: 'spoofed-session' },
          user: { user_id: USER_ID, role: ROLES.MEMBER },
        },
        service: {
          get: vi.fn(async () => existingMessage),
        },
      } as unknown as HookContext;

      await resolveSessionContext()(ctx);

      expect(ctx.params.sessionId).toBe(session.session_id);
      expect(
        (ctx.params as { _agorPrefetchedRecord?: { record: unknown } })._agorPrefetchedRecord
      ).toMatchObject({
        id: existingMessage.message_id,
        idField: 'message_id',
        record: existingMessage,
      });
    }
  );
});

describe('paginateClientSide', () => {
  type Row = { id: string; branch_id?: string; schedule_id?: string; n?: number };
  const rows: Row[] = [
    { id: 'a', branch_id: 'br1', schedule_id: 'sch1', n: 3 },
    { id: 'b', branch_id: 'br1', schedule_id: 'sch2', n: 1 },
    { id: 'c', branch_id: 'br2', schedule_id: 'sch1', n: 2 },
    { id: 'd', branch_id: 'br2', schedule_id: 'sch2', n: 4 },
    { id: 'e', branch_id: 'br2', schedule_id: 'sch1', n: 5 },
  ];

  describe('generic equality filter (the H2 fix)', () => {
    it('filters by a single non-$ field — the runs-panel case', () => {
      // Before this PR, scopeSessionQuery silently ignored the
      // schedule_id filter and returned all accessible sessions.
      const result = paginateClientSide(rows, { schedule_id: 'sch1' });
      expect(result.total).toBe(3);
      expect(result.data.map((r) => r.id)).toEqual(['a', 'c', 'e']);
    });

    it('AND-combines multiple field filters', () => {
      const result = paginateClientSide(rows, { branch_id: 'br2', schedule_id: 'sch1' });
      expect(result.total).toBe(2);
      expect(result.data.map((r) => r.id)).toEqual(['c', 'e']);
    });

    it('skips $-prefixed query operators (pagination/sort handled separately)', () => {
      const result = paginateClientSide(rows, { $limit: 2, $skip: 1 });
      // No equality filters applied; pagination should slice 5 → 2.
      expect(result.total).toBe(5);
      expect(result.data).toHaveLength(2);
    });

    it('honors `skipFilterKeys` (caller already pushed those into SQL)', () => {
      const result = paginateClientSide(rows, { branch_id: 'br1' }, new Set(['branch_id']));
      // branch_id is in skipFilterKeys → not re-applied client-side.
      expect(result.total).toBe(5);
    });

    it('returns no matches when filter has no hits', () => {
      const result = paginateClientSide(rows, { schedule_id: 'nope' });
      expect(result.total).toBe(0);
      expect(result.data).toEqual([]);
    });
  });

  describe('$sort', () => {
    it('sorts ascending by default', () => {
      const result = paginateClientSide(rows, { $sort: { n: 1 } });
      expect(result.data.map((r) => r.n)).toEqual([1, 2, 3, 4, 5]);
    });

    it('sorts descending when order is -1', () => {
      const result = paginateClientSide(rows, { $sort: { n: -1 } });
      expect(result.data.map((r) => r.n)).toEqual([5, 4, 3, 2, 1]);
    });

    it('places null/undefined values last regardless of order', () => {
      const withNulls: Row[] = [{ id: 'x' }, { id: 'y', n: 1 }, { id: 'z' }];
      const asc = paginateClientSide(withNulls, { $sort: { n: 1 } });
      expect(asc.data.map((r) => r.id)).toEqual(['y', 'x', 'z']);
      const desc = paginateClientSide(withNulls, { $sort: { n: -1 } });
      expect(desc.data[0].id).toBe('y');
    });
  });

  describe('pagination', () => {
    it('applies $limit', () => {
      const result = paginateClientSide(rows, { $limit: 2 });
      expect(result.limit).toBe(2);
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(5); // total reflects pre-pagination filtered count
    });

    it('applies $skip', () => {
      const result = paginateClientSide(rows, { $skip: 3 });
      expect(result.skip).toBe(3);
      expect(result.data).toHaveLength(2);
    });

    it('defaults limit to filtered length when omitted', () => {
      const result = paginateClientSide(rows, {});
      expect(result.limit).toBe(5);
      expect(result.data).toHaveLength(5);
    });
  });

  describe('combined filter + sort + paginate', () => {
    it('filters, then sorts, then paginates', () => {
      const result = paginateClientSide(rows, {
        branch_id: 'br2',
        $sort: { n: -1 },
        $limit: 2,
      });
      // br2 rows: c(n=2), d(n=4), e(n=5); sorted desc → [5,4,2]; limit 2 → [5,4]
      expect(result.total).toBe(3);
      expect(result.data.map((r) => r.n)).toEqual([5, 4]);
    });
  });

  describe('edge cases', () => {
    it('handles undefined query', () => {
      const result = paginateClientSide(rows, undefined);
      expect(result.total).toBe(5);
      expect(result.data).toEqual(rows);
    });

    it('handles empty rows', () => {
      const result = paginateClientSide([] as Row[], { branch_id: 'br1' });
      expect(result.total).toBe(0);
      expect(result.data).toEqual([]);
    });
  });
});

describe('setSessionUnixUsername', () => {
  const makeCreateContext = () =>
    ({
      method: 'create',
      path: 'sessions',
      params: { provider: 'rest', user: { user_id: USER_ID } },
      data: {} as Record<string, unknown>,
    }) as unknown as HookContext;

  const repoWithUsername = (unix_username: string | null) => ({
    findById: vi.fn().mockResolvedValue({ user_id: USER_ID, unix_username }),
  });

  it('stamps the creator current unix_username', async () => {
    const ctx = makeCreateContext();
    await setSessionUnixUsername(repoWithUsername('alice'))(ctx);
    expect((ctx.data as { unix_username?: string | null }).unix_username).toBe('alice');
  });

  it('stamps null silently when the mode does not require a unix_username', async () => {
    const ctx = makeCreateContext();
    await setSessionUnixUsername(repoWithUsername(null), 'simple')(ctx);
    expect((ctx.data as { unix_username?: string | null }).unix_username).toBeNull();
  });

  it('rejects a creator without unix_username when the mode requires one', async () => {
    const ctx = makeCreateContext();
    await expect(setSessionUnixUsername(repoWithUsername(null), 'delegated')(ctx)).rejects.toThrow(
      /unix_user_mode 'delegated' requires a unix_username/
    );
  });

  it('skips internal calls even when the mode requires a unix_username', async () => {
    const ctx = {
      method: 'create',
      path: 'sessions',
      params: {},
      data: {},
    } as unknown as HookContext;
    await setSessionUnixUsername(repoWithUsername(null), 'delegated')(ctx);
    expect((ctx.data as { unix_username?: string | null }).unix_username).toBeUndefined();
  });
});
