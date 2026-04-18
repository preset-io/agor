/**
 * RBAC find() scoping tests.
 *
 * Covers the helpers that scope find() queries on worktree-scoped and
 * session-scoped resources to only the rows a caller can access.
 *
 * These helpers are the server-side backstop for per-resource RBAC: without
 * them, authenticated members could list rows from worktrees/sessions that
 * their RBAC get/patch/remove hooks otherwise correctly guard.
 */

import type { SessionRepository, WorktreeRepository } from '@agor/core/db';
import type { HookContext, Session, Worktree } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  scopeFindToAccessibleSessions,
  scopeFindToAccessibleWorktrees,
} from './worktree-authorization';

const USER_ID = 'user-aaaa-0001' as import('@agor/core/types').UUID;

function makeWorktree(id: string, others_can: Worktree['others_can'] = 'view'): Worktree {
  return {
    worktree_id: id as Worktree['worktree_id'],
    repo_id: 'repo-aaaa-0001' as Worktree['repo_id'],
    name: `wt-${id}`,
    branch: 'main',
    path: `/tmp/${id}`,
    others_can,
    archived: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  } as Worktree;
}

function makeSession(id: string, worktreeId: string): Session {
  return {
    session_id: id,
    worktree_id: worktreeId,
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

function fakeWorktreeRepo(accessible: Worktree[]): WorktreeRepository {
  return {
    findAccessibleWorktrees: vi.fn(async () => accessible),
  } as any;
}

function fakeSessionRepo(accessible: Session[]): SessionRepository {
  return {
    findAccessibleSessions: vi.fn(async () => accessible),
  } as any;
}

describe('scopeFindToAccessibleWorktrees', () => {
  it('passes through internal calls (no provider)', async () => {
    const repo = fakeWorktreeRepo([]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({ provider: undefined, user: undefined });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect(repo.findAccessibleWorktrees).not.toHaveBeenCalled();
  });

  it('passes through service accounts', async () => {
    const repo = fakeWorktreeRepo([]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { _isServiceAccount: true },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect(repo.findAccessibleWorktrees).not.toHaveBeenCalled();
  });

  it('returns empty result for unauthenticated requests', async () => {
    const repo = fakeWorktreeRepo([]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({ provider: 'rest', user: undefined });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
    expect((out.result as any).total).toBe(0);
  });

  it('bypasses scoping for superadmins', async () => {
    const repo = fakeWorktreeRepo([]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect((out.params.query as any).worktree_id).toBeUndefined();
  });

  it('honors allow_superadmin=false', async () => {
    const repo = fakeWorktreeRepo([makeWorktree('wt1')]);
    const hook = scopeFindToAccessibleWorktrees(repo, { allowSuperadmin: false });
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.SUPERADMIN },
    });
    await hook(ctx);
    expect((ctx.params.query as any).worktree_id).toEqual({ $in: ['wt1'] });
  });

  it('injects worktree_id $in when no explicit filter', async () => {
    const repo = fakeWorktreeRepo([makeWorktree('wt1'), makeWorktree('wt2')]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    await hook(ctx);
    const q = ctx.params.query as any;
    expect(q.worktree_id.$in.sort()).toEqual(['wt1', 'wt2']);
  });

  it('preserves explicit worktree_id within accessible set', async () => {
    const repo = fakeWorktreeRepo([makeWorktree('wt1'), makeWorktree('wt2')]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { worktree_id: 'wt1' },
    });
    await hook(ctx);
    expect((ctx.params.query as any).worktree_id).toBe('wt1');
  });

  it('short-circuits when explicit worktree_id is outside accessible set', async () => {
    const repo = fakeWorktreeRepo([makeWorktree('wt1')]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { worktree_id: 'wt999' },
    });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('intersects $in arrays with accessible set', async () => {
    const repo = fakeWorktreeRepo([makeWorktree('wt1'), makeWorktree('wt2')]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
      query: { worktree_id: { $in: ['wt1', 'wt999'] } },
    });
    await hook(ctx);
    expect((ctx.params.query as any).worktree_id).toEqual({ $in: ['wt1'] });
  });

  it('returns empty when user has zero accessible worktrees', async () => {
    const repo = fakeWorktreeRepo([]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    const out = await hook(ctx);
    expect((out.result as any).data).toEqual([]);
  });

  it('does not apply on non-find methods', async () => {
    const repo = fakeWorktreeRepo([makeWorktree('wt1')]);
    const hook = scopeFindToAccessibleWorktrees(repo);
    const ctx = makeContext({
      method: 'get',
      provider: 'rest',
      user: { user_id: USER_ID, role: ROLES.MEMBER },
    });
    const out = await hook(ctx);
    expect(out.result).toBeUndefined();
    expect((ctx.params.query as any).worktree_id).toBeUndefined();
    expect(repo.findAccessibleWorktrees).not.toHaveBeenCalled();
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
