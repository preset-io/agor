/**
 * RBAC find() scoping tests.
 *
 * Covers the helpers that scope find() queries on branch-scoped and
 * session-scoped resources to only the rows a caller can access.
 *
 * These helpers are the server-side backstop for per-resource RBAC: without
 * them, authenticated members could list rows from branches/sessions that
 * their RBAC get/patch/remove hooks otherwise correctly guard.
 */

import type { BranchRepository, SessionRepository } from '@agor/core/db';
import type { Branch, HookContext, Session } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  scopeFindToAccessibleBoardsSql,
  scopeFindToAccessibleBranches,
  scopeFindToAccessibleBranchesSql,
  scopeFindToAccessibleSessions,
  scopeFindToAccessibleSessionsSql,
} from './branch-authorization';

const USER_ID = 'user-aaaa-0001' as import('@agor/core/types').UUID;

function makeBranch(id: string, others_can: Branch['others_can'] = 'view'): Branch {
  return {
    branch_id: id as Branch['branch_id'],
    repo_id: 'repo-aaaa-0001' as Branch['repo_id'],
    name: `wt-${id}`,
    branch: 'main',
    path: `/tmp/${id}`,
    others_can,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Branch;
}

function makeSession(id: string, branchId: string): Session {
  return {
    session_id: id,
    branch_id: branchId,
    created_by: USER_ID,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as unknown as Session;
}

function makeContext(overrides: {
  method?: 'find' | 'get' | 'create' | 'patch' | 'remove';
  provider?: string | undefined;
  user?: Record<string, unknown> | undefined;
  query?: Record<string, unknown>;
}): HookContext {
  return {
    method: overrides.method ?? 'find',
    path: 'test',
    params: {
      provider: overrides.provider,
      user: overrides.user,
      query: overrides.query ?? {},
    },
  } as any;
}

function fakeBranchRepo(accessible: Branch[]): BranchRepository {
  return {
    findAccessibleBranches: vi.fn(async () => accessible),
  } as any;
}

function fakeSessionRepo(accessible: Session[]): SessionRepository {
  return {
    findAccessibleSessions: vi.fn(async () => accessible),
  } as any;
}

describe('scopeFindToAccessibleBranches', () => {
  it('passes through internal calls (no provider)', async () => {
    const repo = fakeBranchRepo([]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({ provider: undefined, user: undefined });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect(repo.findAccessibleBranches).not.toHaveBeenCalled();
  });

  it('passes through service accounts', async () => {
    const repo = fakeBranchRepo([]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { _isServiceAccount: true },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect(repo.findAccessibleBranches).not.toHaveBeenCalled();
  });

  it('returns empty result for unauthenticated requests', async () => {
    const repo = fakeBranchRepo([]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({ provider: 'rest', user: undefined });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
    expect((out.result as any).total).toBe(0);
  });

  it('bypasses scoping for superadmins', async () => {
    const repo = fakeBranchRepo([]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect((out.params.query as any).branch_id).toBeUndefined();
  });

  it('honors allow_superadmin=false', async () => {
    const repo = fakeBranchRepo([makeBranch('wt1')]);
    const hook = scopeFindToAccessibleBranches(repo, { allowSuperadmin: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    await hook(ctx);
    expect((ctx.params.query as any).branch_id).toEqual({ $in: ['wt1'] });
  });

  it('injects branch_id $in when no explicit filter', async () => {
    const repo = fakeBranchRepo([makeBranch('wt1'), makeBranch('wt2')]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    await hook(ctx);
    const q = ctx.params.query as any;
    expect(q.branch_id.$in.sort()).toEqual(['wt1', 'wt2']);
  });

  it('preserves explicit branch_id within accessible set', async () => {
    const repo = fakeBranchRepo([makeBranch('wt1'), makeBranch('wt2')]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { branch_id: 'wt1' },
    });
    await hook(ctx);
    expect((ctx.params.query as any).branch_id).toBe('wt1');
  });

  it('short-circuits when explicit branch_id is outside accessible set', async () => {
    const repo = fakeBranchRepo([makeBranch('wt1')]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { branch_id: 'wt999' },
    });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('intersects $in arrays with accessible set', async () => {
    const repo = fakeBranchRepo([makeBranch('wt1'), makeBranch('wt2')]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { branch_id: { $in: ['wt1', 'wt999'] } },
    });
    await hook(ctx);
    expect((ctx.params.query as any).branch_id).toEqual({ $in: ['wt1'] });
  });

  it('returns empty when user has zero accessible branches', async () => {
    const repo = fakeBranchRepo([]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('does not apply on non-find methods', async () => {
    const repo = fakeBranchRepo([makeBranch('wt1')]);
    const hook = scopeFindToAccessibleBranches(repo);
    const ctx = makeContext({
      method: 'get',
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect((ctx.params.query as any).branch_id).toBeUndefined();
    expect(repo.findAccessibleBranches).not.toHaveBeenCalled();
  });
});

describe('scopeFindToAccessibleBranchesSql', () => {
  it('marks regular external callers for repository SQL visibility pushdown', async () => {
    const hook = scopeFindToAccessibleBranchesSql();
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { branch_id: 'wt1' },
    });

    await hook(ctx);

    expect((ctx.params as any)._agorSqlBranchAccessUserId).toBe(USER_ID);
    // The SQL path deliberately does not materialize/intersect ids in the hook;
    // explicit filters are composed with visibility in the repository query.
    expect((ctx.params.query as any).branch_id).toBe('wt1');
  });

  it('preserves superadmin and internal pass-through semantics', async () => {
    const hook = scopeFindToAccessibleBranchesSql();
    const superCtx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    const internalCtx = makeContext({ provider: undefined, user: undefined });

    await hook(superCtx);
    await hook(internalCtx);

    expect((superCtx.params as any)._agorSqlBranchAccessUserId).toBeUndefined();
    expect((internalCtx.params as any)._agorSqlBranchAccessUserId).toBeUndefined();
  });

  it('returns an empty find result for unauthenticated external callers', async () => {
    const hook = scopeFindToAccessibleBranchesSql();
    const ctx = makeContext({ provider: 'rest', user: undefined, query: { $limit: 25 } });

    const out = await hook(ctx);

    expect((out.result as any).data).toEqual([]);
    expect((out.result as any).total).toBe(0);
    expect((out.result as any).limit).toBe(25);
  });
});

describe('scopeFindToAccessibleBoardsSql', () => {
  it('marks regular external callers for repository SQL board visibility pushdown', async () => {
    const hook = scopeFindToAccessibleBoardsSql();
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { board_id: 'board1' },
    });

    await hook(ctx);

    expect((ctx.params as any)._agorSqlBoardAccessUserId).toBe(USER_ID);
    expect((ctx.params.query as any).board_id).toBe('board1');
  });
});

describe('scopeFindToAccessibleSessionsSql', () => {
  it('marks regular external callers for repository SQL session visibility pushdown', async () => {
    const hook = scopeFindToAccessibleSessionsSql();
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { session_id: 's1' },
    });

    await hook(ctx);

    expect((ctx.params as any)._agorSqlSessionAccessUserId).toBe(USER_ID);
    expect((ctx.params.query as any).session_id).toBe('s1');
  });
});

describe('scopeFindToAccessibleSessions', () => {
  it('passes through internal calls', async () => {
    const repo = fakeSessionRepo([]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({ provider: undefined, user: undefined });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect(repo.findAccessibleSessions).not.toHaveBeenCalled();
  });

  it('passes through service accounts', async () => {
    const repo = fakeSessionRepo([]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { _isServiceAccount: true },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect(repo.findAccessibleSessions).not.toHaveBeenCalled();
  });

  it('returns empty for unauthenticated', async () => {
    const repo = fakeSessionRepo([]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({ provider: 'rest', user: undefined });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('bypasses scoping for superadmins', async () => {
    const repo = fakeSessionRepo([]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect((ctx.params.query as any).session_id).toBeUndefined();
  });

  it('honors allow_superadmin=false', async () => {
    const repo = fakeSessionRepo([makeSession('s1', 'wt1')]);
    const hook = scopeFindToAccessibleSessions(repo, { allowSuperadmin: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    await hook(ctx);
    expect((ctx.params.query as any).session_id).toEqual({ $in: ['s1'] });
  });

  it('injects session_id $in when no explicit filter', async () => {
    const repo = fakeSessionRepo([makeSession('s1', 'wt1'), makeSession('s2', 'wt2')]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    await hook(ctx);
    const q = ctx.params.query as any;
    expect(q.session_id.$in.sort()).toEqual(['s1', 's2']);
  });

  it('preserves explicit session_id within accessible set', async () => {
    const repo = fakeSessionRepo([makeSession('s1', 'wt1'), makeSession('s2', 'wt2')]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { session_id: 's1' },
    });
    await hook(ctx);
    expect((ctx.params.query as any).session_id).toBe('s1');
  });

  it('short-circuits when explicit session_id is outside accessible set', async () => {
    const repo = fakeSessionRepo([makeSession('s1', 'wt1')]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { session_id: 's-other' },
    });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('intersects $in session arrays with accessible set', async () => {
    const repo = fakeSessionRepo([makeSession('s1', 'wt1'), makeSession('s2', 'wt2')]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { session_id: { $in: ['s1', 's-other'] } },
    });
    await hook(ctx);
    expect((ctx.params.query as any).session_id).toEqual({ $in: ['s1'] });
  });

  it('returns empty when user has zero accessible sessions', async () => {
    const repo = fakeSessionRepo([]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('does not apply on non-find methods', async () => {
    const repo = fakeSessionRepo([makeSession('s1', 'wt1')]);
    const hook = scopeFindToAccessibleSessions(repo);
    const ctx = makeContext({
      method: 'patch',
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect((ctx.params.query as any).session_id).toBeUndefined();
    expect(repo.findAccessibleSessions).not.toHaveBeenCalled();
  });
});
