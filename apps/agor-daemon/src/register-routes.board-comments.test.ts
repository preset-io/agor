import { getCurrentTenantDatabaseScope, getCurrentTenantId } from '@agor/core/db';
import type { BoardComment, HookContext, UUID } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  authorizeBoardCommentReposition,
  authorizeBoardCommentRouteAccess,
  boardCommentReactionInput,
  boardCommentReplyInput,
} from './register-routes.js';
import { createTenantScopedAuthenticatedRouteRegistrar } from './utils/tenant-authenticated-route.js';

const USER = '018f0000-0000-7000-8000-000000000001';
const OTHER = '018f0000-0000-7000-8000-000000000002';
const COMMENT = {
  comment_id: '018f0000-0000-7000-8000-000000000003',
  board_id: '018f0000-0000-7000-8000-000000000004',
  content: 'private comment',
  created_by: OTHER,
} as BoardComment;

function params(role = ROLES.MEMBER) {
  return {
    provider: 'socketio',
    user: { user_id: USER, email: 'member@example.test', role },
  } as const;
}

describe('board comment custom-route authorization', () => {
  it('requires current attachment visibility and does not enumerate denied comments', async () => {
    const findComment = vi.fn(async () => COMMENT);
    const findVisibleComment = vi.fn(async () => null);
    const denied = await authorizeBoardCommentRouteAccess({
      commentId: COMMENT.comment_id,
      params: params(),
      findComment,
      findVisibleComment,
    }).catch((error: Error & { code?: number }) => ({
      code: error.code,
      message: error.message,
    }));
    const missing = await authorizeBoardCommentRouteAccess({
      commentId: 'missing',
      params: params(),
      findComment: async () => null,
      findVisibleComment,
    }).catch((error: Error & { code?: number }) => ({
      code: error.code,
      message: error.message,
    }));

    expect(denied).toEqual(missing);
    expect(denied).toMatchObject({ code: 404 });
    expect(findVisibleComment).toHaveBeenCalledWith(COMMENT.comment_id, USER as UUID);
  });

  it('allows a current viewer and preserves the admin authority path', async () => {
    await expect(
      authorizeBoardCommentRouteAccess({
        commentId: COMMENT.comment_id,
        params: params(),
        findComment: async () => COMMENT,
        findVisibleComment: async () => COMMENT,
      })
    ).resolves.toBe(COMMENT);

    const findVisibleComment = vi.fn(async () => null);
    await expect(
      authorizeBoardCommentRouteAccess({
        commentId: COMMENT.comment_id,
        params: params(ROLES.ADMIN),
        findComment: async () => COMMENT,
        findVisibleComment,
      })
    ).resolves.toBe(COMMENT);
    expect(findVisibleComment).not.toHaveBeenCalled();
  });

  it('derives reaction/reply ownership and strips caller-controlled resource fields', () => {
    expect(boardCommentReactionInput({ user_id: OTHER, emoji: '👍' } as never, params())).toEqual({
      user_id: USER,
      emoji: '👍',
    });
    expect(
      boardCommentReplyInput(
        {
          content: 'reply',
          created_by: OTHER,
          board_id: 'foreign-board' as never,
          parent_comment_id: 'foreign-parent' as never,
          reactions: [{ user_id: OTHER as never, emoji: '👎' }],
          mentions: [OTHER as never],
          resolved: true,
        },
        params()
      )
    ).toEqual({
      content: 'reply',
      created_by: USER,
      mentions: [OTHER],
    });
  });

  it('keeps spatial movement bound to the existing author and audience anchor', async () => {
    const branchComment = {
      ...COMMENT,
      created_by: USER,
      branch_id: 'branch-1',
    } as BoardComment;
    await expect(
      authorizeBoardCommentReposition({
        comment: branchComment,
        data: {
          branch_id: 'branch-1' as never,
          position: {
            relative: {
              parent_id: 'branch-1',
              parent_type: 'branch',
              offset_x: 2,
              offset_y: 3,
            },
          },
        },
        params: params(),
        findBoard: async () => null,
        findVisibleBoard: async () => null,
      })
    ).resolves.toBeUndefined();

    await expect(
      authorizeBoardCommentReposition({
        comment: branchComment,
        data: {
          branch_id: 'hidden-branch' as never,
          position: { absolute: { x: 1, y: 2 } },
        },
        params: params(),
        findBoard: async () => null,
        findVisibleBoard: async () => null,
      })
    ).rejects.toThrow(/attachments cannot be changed/);

    await expect(
      authorizeBoardCommentReposition({
        comment: branchComment,
        data: {
          branch_id: 'branch-1' as never,
          position: {
            relative: {
              parent_id: 'hidden-branch',
              parent_type: 'branch',
              offset_x: 2,
              offset_y: 3,
            },
          },
        },
        params: params(),
        findBoard: async () => null,
        findVisibleBoard: async () => null,
      })
    ).rejects.toThrow(/does not match its attachment/);
  });

  it('validates zone parents on the same board and rejects non-authors', async () => {
    const ownComment = { ...COMMENT, created_by: USER } as BoardComment;
    const position = {
      relative: {
        parent_id: '1',
        parent_type: 'zone' as const,
        offset_x: 2,
        offset_y: 3,
      },
    };
    await expect(
      authorizeBoardCommentReposition({
        comment: ownComment,
        data: { branch_id: null, position },
        params: params(),
        findBoard: async () =>
          ({ board_id: COMMENT.board_id, objects: { 'zone-1': { type: 'zone' } } }) as never,
        findVisibleBoard: async () =>
          ({ board_id: COMMENT.board_id, objects: { 'zone-1': { type: 'zone' } } }) as never,
      })
    ).resolves.toBeUndefined();
    await expect(
      authorizeBoardCommentReposition({
        comment: ownComment,
        data: { branch_id: null, position },
        params: params(),
        findBoard: async () =>
          ({ board_id: COMMENT.board_id, objects: { 'zone-1': { type: 'markdown' } } }) as never,
        findVisibleBoard: async () =>
          ({ board_id: COMMENT.board_id, objects: { 'zone-1': { type: 'markdown' } } }) as never,
      })
    ).rejects.toThrow(/Board resource not found/);
    await expect(
      authorizeBoardCommentReposition({
        comment: COMMENT,
        data: { branch_id: null, position: { absolute: { x: 1, y: 2 } } },
        params: params(),
        findBoard: async () => null,
        findVisibleBoard: async () => null,
      })
    ).rejects.toThrow(/Only the comment author/);
  });

  it('does not expose a known zone on a board hidden from an attached-branch viewer', async () => {
    const branchVisibleComment = {
      ...COMMENT,
      created_by: USER,
      branch_id: 'branch-visible',
    } as BoardComment;
    const data = {
      branch_id: 'branch-visible' as never,
      position: {
        relative: {
          parent_id: 'secret',
          parent_type: 'zone' as const,
          offset_x: 2,
          offset_y: 3,
        },
      },
    };
    const findBoard = vi.fn(async () =>
      Promise.resolve({
        board_id: COMMENT.board_id,
        objects: { 'zone-secret': { type: 'zone' } },
      } as never)
    );

    const hidden = await authorizeBoardCommentReposition({
      comment: branchVisibleComment,
      data,
      params: params(),
      findBoard,
      findVisibleBoard: async () => null,
    }).catch((error: Error & { code?: number }) => ({ code: error.code, message: error.message }));
    const missing = await authorizeBoardCommentReposition({
      comment: branchVisibleComment,
      data,
      params: params(),
      findBoard,
      findVisibleBoard: async () => ({ board_id: COMMENT.board_id, objects: {} }) as never,
    }).catch((error: Error & { code?: number }) => ({ code: error.code, message: error.message }));

    expect(hidden).toEqual(missing);
    expect(hidden).toMatchObject({ code: 404, message: 'Board resource not found' });
    expect(findBoard).not.toHaveBeenCalled();
  });
});

describe('tenant-scoped custom-route registration', () => {
  function installRoute(execute: ReturnType<typeof vi.fn>) {
    let installed:
      | {
          around?: {
            all?: Array<(context: HookContext, next: () => Promise<void>) => Promise<void>>;
          };
        }
      | undefined;
    const tx = { execute };
    const db = {
      transaction: vi.fn(async (work: (transaction: unknown) => Promise<unknown>) => work(tx)),
    };
    const app = {
      use: vi.fn(),
      service: vi.fn(() => ({
        hooks: (hooks: typeof installed) => {
          installed = hooks;
        },
      })),
    };
    const register = createTenantScopedAuthenticatedRouteRegistrar({
      db: db as never,
      config: { multi_tenancy: { mode: 'static', static_tenant_id: 'tenant-route' } },
      jwtSecret: 'secret',
    });
    register(
      app,
      '/board-comments/:id/reposition',
      { async create() {} },
      { create: { role: ROLES.MEMBER, action: 'reposition board comments' } },
      async (context: HookContext) => context
    );
    return { installed, tx };
  }

  async function runInstalledAroundHooks(
    installed: {
      around?: { all?: Array<(context: HookContext, next: () => Promise<void>) => Promise<void>> };
    },
    next: () => Promise<void>,
    method = 'create'
  ) {
    const context = { method, params: {}, data: {} } as HookContext;
    const run = (installed.around?.all ?? []).reduceRight<() => Promise<void>>(
      (inner, hook) => () => hook(context, inner),
      next
    );
    await run();
    return context;
  }

  it('installs the tenant transaction and write gate on routes registered after service hooks', async () => {
    const execute = vi.fn(async () => []);
    const { installed, tx } = installRoute(execute);
    const handler = vi.fn(async () => {
      expect(getCurrentTenantId()).toBe('tenant-route');
      expect(getCurrentTenantDatabaseScope()?.db).toBe(tx);
    });

    expect(installed?.around?.all).toHaveLength(2);
    await runInstalledAroundHooks(installed ?? {}, handler);

    expect(handler).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('blocks a custom mutation when the installed tenant write gate is held', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        {
          value_text: JSON.stringify({
            generation: 'gate-generation',
            acquiredAt: '2026-08-21T00:00:00.000Z',
          }),
        },
      ]);
    const { installed } = installRoute(execute);
    const handler = vi.fn(async () => undefined);

    await expect(runInstalledAroundHooks(installed ?? {}, handler)).rejects.toMatchObject({
      code: 503,
    });
    expect(handler).not.toHaveBeenCalled();
  });

  it('does not over-gate a recognized custom read on the installed route boundary', async () => {
    const execute = vi.fn(async () => [
      {
        value_text: JSON.stringify({
          generation: 'gate-generation',
          acquiredAt: '2026-08-21T00:00:00.000Z',
        }),
      },
    ]);
    const { installed } = installRoute(execute);
    const handler = vi.fn(async () => undefined);

    await runInstalledAroundHooks(installed ?? {}, handler, 'getPrimaryTeammate');

    expect(handler).toHaveBeenCalledOnce();
    expect(execute).toHaveBeenCalledOnce();
  });
});
