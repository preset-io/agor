import type { MCPServer } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  isMcpServerUsableByCaller,
  isSessionMcpServerLinkVisibleToCaller,
} from './mcp-server-authorization.js';

const server = (owner_user_id?: string) =>
  ({ mcp_server_id: 'server-id', owner_user_id }) as unknown as MCPServer;

describe('isMcpServerUsableByCaller', () => {
  it('allows shared servers and the owner, but not another member', () => {
    expect(
      isMcpServerUsableByCaller(server(), {
        provider: 'rest',
        user: { user_id: 'user-a' },
      } as never)
    ).toBe(true);
    expect(
      isMcpServerUsableByCaller(server('user-a'), {
        provider: 'rest',
        user: { user_id: 'user-a' },
      } as never)
    ).toBe(true);
    expect(
      isMcpServerUsableByCaller(server('user-a'), {
        provider: 'rest',
        user: { user_id: 'user-b' },
      } as never)
    ).toBe(false);
  });

  it('allows admins and trusted internal callers', () => {
    expect(
      isMcpServerUsableByCaller(server('user-a'), {
        provider: 'rest',
        user: { user_id: 'user-b', role: 'admin' },
      } as never)
    ).toBe(true);
    expect(isMcpServerUsableByCaller(server('user-a'), undefined)).toBe(true);
  });
});

describe('isSessionMcpServerLinkVisibleToCaller', () => {
  const member = (user_id: string) => ({ provider: 'rest', user: { user_id } }) as never;

  it('hides a session creator private attachment from a collaborator', () => {
    const row = { owner_user_id: 'creator', session_created_by: 'creator' };
    expect(isSessionMcpServerLinkVisibleToCaller(row, member('collaborator'))).toBe(false);
    expect(isSessionMcpServerLinkVisibleToCaller(row, member('creator'))).toBe(true);
    expect(
      isSessionMcpServerLinkVisibleToCaller(
        { owner_user_id: 'foreign', session_created_by: 'creator' },
        member('creator')
      )
    ).toBe(false);
  });

  it('keeps shared links visible and allows admin/control-plane callers', () => {
    const row = { owner_user_id: null, session_created_by: 'creator' };
    expect(isSessionMcpServerLinkVisibleToCaller(row, member('collaborator'))).toBe(true);
    expect(
      isSessionMcpServerLinkVisibleToCaller(
        { owner_user_id: 'creator', session_created_by: 'creator' },
        { provider: 'rest', user: { user_id: 'admin', role: 'admin' } } as never
      )
    ).toBe(true);
    expect(
      isSessionMcpServerLinkVisibleToCaller(
        { owner_user_id: 'creator', session_created_by: 'creator' },
        undefined
      )
    ).toBe(true);
  });
});
