/**
 * Branch Authorization Tests
 *
 * Tests for superadmin role, allow_superadmin config flag, and branch RBAC behavior.
 * Covers the security invariants introduced by the superadmin role feature.
 */

import type { SessionRepository } from '@agor/core/db';
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
  resolveBranchPermission,
  resolveSessionContext,
  scopeSessionQuery,
} from './branch-authorization';

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
      // Can view because others_can=view (not because of superadmin)
      expect(hasBranchPermission(wt, USER_ID, false, 'view', ROLES.SUPERADMIN, false)).toBe(true);
      // Cannot prompt because others_can=view only
      expect(hasBranchPermission(wt, USER_ID, false, 'prompt', ROLES.SUPERADMIN, false)).toBe(
        false
      );
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
    ])('others_can=%s, required=%s → %s', (othersCan, required, expected) => {
      const wt = makeBranch({ others_can: othersCan });
      expect(hasBranchPermission(wt, USER_ID, false, required, ROLES.MEMBER)).toBe(expected);
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

  it('member gets others_can level', () => {
    const wt = makeBranch({ others_can: 'prompt' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('prompt');
  });

  it('member gets none when others_can=none', () => {
    const wt = makeBranch({ others_can: 'none' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('none');
  });

  it('member gets session when others_can=session', () => {
    const wt = makeBranch({ others_can: 'session' });
    expect(resolveBranchPermission(wt, USER_ID, false, ROLES.MEMBER)).toBe('session');
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
  const hook = ensureCanPromptInSession();

  describe('session tier — own sessions', () => {
    it('allows prompting own session with session permission', () => {
      const wt = makeBranch({ others_can: 'session' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).not.toThrow();
    });

    it('denies prompting another users session with session permission', () => {
      const wt = makeBranch({ others_can: 'session' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).toThrow(/you can only prompt sessions you created/i);
    });
  });

  describe('prompt tier — any session', () => {
    it('allows prompting another users session with prompt permission', () => {
      const wt = makeBranch({ others_can: 'prompt' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).not.toThrow();
    });
  });

  describe('view tier — denied', () => {
    it('denies prompting own session with view permission', () => {
      const wt = makeBranch({ others_can: 'view' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: USER_ID },
        userId: USER_ID,
      });
      expect(() => hook(ctx)).toThrow(/need 'prompt' permission/i);
    });
  });

  describe('owner bypass', () => {
    it('owner can prompt any session regardless of others_can', () => {
      const wt = makeBranch({ others_can: 'none' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
        isOwner: true,
      });
      expect(() => hook(ctx)).not.toThrow();
    });
  });

  describe('internal calls bypass', () => {
    it('skips check for internal calls (no provider)', () => {
      const wt = makeBranch({ others_can: 'none' });
      const ctx = makeHookContext({
        branch: wt,
        session: { created_by: OTHER_USER_ID },
        userId: USER_ID,
      });
      // Remove provider to simulate internal call
      ctx.params.provider = undefined;
      expect(() => hook(ctx)).not.toThrow();
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
    const sessionService = { get: vi.fn(async () => session) };
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

    await loadSession(sessionService)(ctx);
    await loadSession(sessionService)(ctx);
    await loadBranchFromSession(branchRepo as never)(ctx);
    await loadBranchFromSession(branchRepo as never)(ctx);

    expect(sessionService.get).toHaveBeenCalledTimes(1);
    expect(branchRepo.findById).toHaveBeenCalledTimes(1);
    expect(branchRepo.isOwner).toHaveBeenCalledTimes(1);
    expect(branchRepo.resolveUserPermission).toHaveBeenCalledTimes(1);
  });

  it('marks sessions.get hook-loaded session as prefetched for the service get()', async () => {
    const sessionService = { get: vi.fn(async () => session) };
    const branchRepo = makeBranchRepo();
    const ctx = {
      path: 'sessions',
      method: 'get',
      id: session.session_id,
      params: {
        provider: 'rest',
        user: { user_id: USER_ID, role: ROLES.MEMBER },
      },
    } as unknown as HookContext;

    await loadSessionBranch(sessionService, branchRepo as never)(ctx);

    expect(sessionService.get).toHaveBeenCalledTimes(1);
    expect(ctx.params.session).toBe(session);
    expect(
      (ctx.params as { _agorPrefetchedRecord?: { record: unknown } })._agorPrefetchedRecord
    ).toMatchObject({
      id: session.session_id,
      idField: 'session_id',
      record: session,
    });
  });

  it('resolves id-addressed message context from the stored record, not spoofed query', async () => {
    const existingMessage = {
      message_id: 'message-cache-1',
      session_id: session.session_id,
    };
    const ctx = {
      path: 'messages',
      method: 'get',
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
  });
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

describe('scopeSessionQuery — $sort handling', () => {
  const SUPERADMIN_USER = {
    user_id: 'user-super-0001' as import('@agor/core/types').UUID,
    role: ROLES.SUPERADMIN,
  };

  function makeSession(id: string, overrides: Partial<Session> = {}): Session {
    return {
      session_id: id,
      branch_id: 'wt-1',
      status: 'idle',
      archived: false,
      created_at: '2026-01-01T00:00:00.000Z',
      last_updated: '2026-01-01T00:00:00.000Z',
      ...overrides,
    } as unknown as Session;
  }

  function makeCtx(query: Record<string, unknown>): HookContext {
    return {
      method: 'find',
      params: { provider: 'socketio', user: SUPERADMIN_USER, query },
    } as unknown as HookContext;
  }

  function repoReturning(sessions: Session[]): SessionRepository {
    return { findAll: vi.fn(async () => sessions) } as unknown as SessionRepository;
  }

  function resultIds(ctx: HookContext): string[] {
    const result = ctx.result as { data: Session[] };
    return result.data.map((s) => s.session_id);
  }

  it('passes a non-updated_at $sort (created_at) through to the client-side sort', async () => {
    // REGRESSION GUARD: scopeSessionQuery must NOT strip every $sort — only the
    // special `updated_at` case it sorts manually. created_at exists on the
    // Session object, so paginateClientSide can order it.
    const sessions = [
      makeSession('s-old', { created_at: '2026-01-01T00:00:00.000Z' }),
      makeSession('s-new', { created_at: '2026-03-01T00:00:00.000Z' }),
      makeSession('s-mid', { created_at: '2026-02-01T00:00:00.000Z' }),
    ];
    const ctx = makeCtx({ $sort: { created_at: -1 }, $limit: 10 });
    await scopeSessionQuery(repoReturning(sessions))(ctx);
    expect(resultIds(ctx)).toEqual(['s-new', 's-mid', 's-old']);
  });

  it('passes a scheduled_run_at $sort through (ScheduleRunsPanel)', async () => {
    const sessions = [
      makeSession('r1', { scheduled_run_at: 100 }),
      makeSession('r3', { scheduled_run_at: 300 }),
      makeSession('r2', { scheduled_run_at: 200 }),
    ];
    const ctx = makeCtx({ $sort: { scheduled_run_at: -1 }, $limit: 10 });
    await scopeSessionQuery(repoReturning(sessions))(ctx);
    expect(resultIds(ctx)).toEqual(['r3', 'r2', 'r1']);
  });

  it('orders the updated_at $sort on the real last_updated field', async () => {
    const sessions = [
      makeSession('u-old', { last_updated: '2026-01-01T00:00:00.000Z' }),
      makeSession('u-new', { last_updated: '2026-03-01T00:00:00.000Z' }),
      makeSession('u-mid', { last_updated: '2026-02-01T00:00:00.000Z' }),
    ];
    const ctx = makeCtx({ $sort: { updated_at: -1 }, $limit: 10 });
    await scopeSessionQuery(repoReturning(sessions))(ctx);
    expect(resultIds(ctx)).toEqual(['u-new', 'u-mid', 'u-old']);
  });
});
