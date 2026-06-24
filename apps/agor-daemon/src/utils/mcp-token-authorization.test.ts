import { describe, expect, it } from 'vitest';
import { canControlCliSession, canReceiveMcpTokenForSession } from './mcp-token-authorization';

const creatorId = 'user-creator';

describe('session actor authorization', () => {
  it('allows a member caller to receive an MCP token as the acting user', () => {
    const params = {
      callerUserId: 'user-collaborator',
      callerRole: 'member',
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(true);
  });

  it('denies MCP tokens to viewers even when they created the session', () => {
    const params = {
      callerUserId: creatorId,
      callerRole: 'viewer',
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(false);
  });

  it('allows superadmins to receive caller-scoped MCP tokens', () => {
    const params = {
      callerUserId: 'user-admin',
      callerRole: 'superadmin',
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(true);
  });

  it('allows the internal service identity to receive MCP tokens', () => {
    const params = {
      callerUserId: undefined,
      callerRole: 'service',
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(true);
  });

  it('denies unauthenticated or role-less callers', () => {
    const params = {
      callerUserId: undefined,
      callerRole: undefined,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(false);
  });

  it('denies MCP tokens when a caller id is present but role is missing', () => {
    expect(
      canReceiveMcpTokenForSession({
        callerUserId: creatorId,
        callerRole: undefined,
      })
    ).toBe(false);
  });

  it('keeps CLI control limited to the creator, superadmin, or service identity', () => {
    expect(
      canControlCliSession({
        callerUserId: creatorId,
        callerRole: 'member',
        sessionCreatedBy: creatorId,
      })
    ).toBe(true);
    expect(
      canControlCliSession({
        callerUserId: 'user-collaborator',
        callerRole: 'member',
        sessionCreatedBy: creatorId,
      })
    ).toBe(false);
    expect(
      canControlCliSession({
        callerUserId: 'user-admin',
        callerRole: 'superadmin',
        sessionCreatedBy: creatorId,
      })
    ).toBe(true);
    expect(
      canControlCliSession({
        callerUserId: undefined,
        callerRole: 'service',
        sessionCreatedBy: creatorId,
      })
    ).toBe(true);
    expect(
      canControlCliSession({
        callerUserId: creatorId,
        callerRole: undefined,
        sessionCreatedBy: creatorId,
      })
    ).toBe(false);
  });
});
