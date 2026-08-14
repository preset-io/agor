import { BadRequest, Forbidden, NotFound } from '@agor/core/feathers';
import type { Branch, Message, Session } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { authorizeMessageBulkCreate, MAX_MESSAGE_BULK_ROWS } from './message-bulk-authorization.js';

function message(sessionId = 'session-private'): Message {
  return { session_id: sessionId } as Message;
}

function dependencies(overrides?: {
  session?: Session | null;
  permission?: 'none' | 'view' | 'session' | 'prompt' | 'all';
  owner?: boolean;
}) {
  const session =
    overrides?.session === undefined
      ? ({
          session_id: 'session-private',
          branch_id: 'branch-private',
          created_by: 'owner-user',
        } as Session)
      : overrides.session;
  const branch = {
    branch_id: 'branch-private',
    others_can: overrides?.permission ?? 'none',
  } as Branch;
  return {
    branchRbacEnabled: true,
    allowSuperadmin: true,
    sessionsRepository: { findById: vi.fn(async () => session) },
    branchRepository: {
      findById: vi.fn(async () => branch),
      isOwner: vi.fn(async () => overrides?.owner ?? false),
      resolveUserPermission: vi.fn(async () => overrides?.permission ?? 'none'),
    },
  };
}

describe('authorizeMessageBulkCreate', () => {
  it('rejects a member who cannot prompt the target Session', async () => {
    await expect(
      authorizeMessageBulkCreate(
        [message()],
        { provider: 'rest', user: { user_id: 'other-user', role: 'member' } } as never,
        dependencies({ permission: 'view' })
      )
    ).rejects.toBeInstanceOf(Forbidden);
  });

  it('allows the Session creator at the session permission tier', async () => {
    const records = [message()];
    await expect(
      authorizeMessageBulkCreate(
        records,
        { provider: 'rest', user: { user_id: 'owner-user', role: 'member' } } as never,
        dependencies({ permission: 'session' })
      )
    ).resolves.toBe(records);
  });

  it('fails closed when tenant scoping hides the Session', async () => {
    await expect(
      authorizeMessageBulkCreate(
        [message()],
        { provider: 'rest', user: { user_id: 'owner-user', role: 'member' } } as never,
        dependencies({ session: null })
      )
    ).rejects.toBeInstanceOf(NotFound);
  });

  it('still validates tenant ownership when branch RBAC is disabled', async () => {
    const deps = dependencies({ session: null });
    deps.branchRbacEnabled = false;
    await expect(
      authorizeMessageBulkCreate(
        [message()],
        { provider: 'rest', user: { user_id: 'owner-user', role: 'member' } } as never,
        deps
      )
    ).rejects.toBeInstanceOf(NotFound);
    expect(deps.sessionsRepository.findById).toHaveBeenCalledWith('session-private');
  });

  it('requires one bounded Session transcript per request', async () => {
    const deps = dependencies();
    await expect(
      authorizeMessageBulkCreate(
        [message('session-a'), message('session-b')],
        { provider: 'rest', user: { user_id: 'owner-user', role: 'member' } } as never,
        deps
      )
    ).rejects.toBeInstanceOf(BadRequest);
    expect(deps.sessionsRepository.findById).not.toHaveBeenCalled();

    await expect(
      authorizeMessageBulkCreate(
        Array.from({ length: MAX_MESSAGE_BULK_ROWS + 1 }, () => message()),
        { provider: 'rest', user: { user_id: 'owner-user', role: 'member' } } as never,
        deps
      )
    ).rejects.toThrow(`limited to ${MAX_MESSAGE_BULK_ROWS} rows`);
  });
});
