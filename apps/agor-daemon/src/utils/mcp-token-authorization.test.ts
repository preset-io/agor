import { describe, expect, it } from 'vitest';
import { canControlCliSession, canReceiveMcpTokenForSession } from './mcp-token-authorization';

const creatorId = 'user-creator';

describe('session actor authorization', () => {
  it('allows the creator when they are a member or higher', () => {
    const params = {
      callerUserId: creatorId,
      callerRole: 'member',
      sessionCreatedBy: creatorId,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(true);
    expect(canControlCliSession(params)).toBe(true);
  });

  it('denies the creator if they are not a member', () => {
    const params = {
      callerUserId: creatorId,
      callerRole: 'viewer',
      sessionCreatedBy: creatorId,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(false);
    expect(canControlCliSession(params)).toBe(false);
  });

  it('denies other members even when they can access the branch', () => {
    const params = {
      callerUserId: 'user-collaborator',
      callerRole: 'member',
      sessionCreatedBy: creatorId,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(false);
    expect(canControlCliSession(params)).toBe(false);
  });

  it('allows superadmins to receive tokens and control CLI sessions', () => {
    const params = {
      callerUserId: 'user-admin',
      callerRole: 'superadmin',
      sessionCreatedBy: creatorId,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(true);
    expect(canControlCliSession(params)).toBe(true);
  });

  it('allows the internal service identity', () => {
    const params = {
      callerUserId: undefined,
      callerRole: 'service',
      sessionCreatedBy: creatorId,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(true);
    expect(canControlCliSession(params)).toBe(true);
  });

  it('denies unauthenticated or role-less callers', () => {
    const params = {
      callerUserId: undefined,
      callerRole: undefined,
      sessionCreatedBy: creatorId,
    };
    expect(canReceiveMcpTokenForSession(params)).toBe(false);
    expect(canControlCliSession(params)).toBe(false);
  });
});
