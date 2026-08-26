import type {
  MCPServerID,
  MCPSlackRecoveryNotice,
  MCPSlackRecoveryTokenClaims,
  SessionID,
  TenantID,
  UserID,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  issueMCPSlackRecoveryToken,
  mcpSlackRecoveryClaimsMatchCaller,
  mcpSlackRecoveryClaimsMatchNotice,
  verifyMCPSlackRecoveryToken,
} from './mcp-slack-recovery-token.js';

const SECRET = 'test-secret-with-enough-entropy';
const NOW = new Date('2026-08-26T12:00:00.000Z');
const EXPIRES = new Date('2026-08-26T12:10:00.000Z');

function notice(): MCPSlackRecoveryNotice {
  return {
    notice_id: 'notice-1',
    token_jti: 'jti-1',
    issued_at: NOW.toISOString(),
    expires_at: EXPIRES.toISOString(),
    principal_user_id: 'user-1' as UserID,
    credential_user_id: 'user-1' as UserID,
    slack_user_id: 'U123',
    slack_team_id: 'T123',
    gateway_channel_id: 'gateway-1',
    gateway_config_generation: 7,
    slack_channel_id: 'C123',
    slack_thread_id: 'C123-1724688000.000100',
    session_id: 'session-1' as SessionID,
    task_id: 'task-1',
    mcp_server_id: 'server-1' as MCPServerID,
    mcp_server_config_version: 3,
    recovery_generation: 11,
    recovery_request_id: 'request-1',
    provider_dispatch: 'ambiguous',
    delivery_id: 'delivery-1',
  };
}

function issue(value = notice()): string {
  return issueMCPSlackRecoveryToken(
    {
      type: 'mcp-slack-recovery',
      tid: 'tenant-1',
      sub: value.principal_user_id,
      credential_user_id: value.credential_user_id,
      slack_user_id: value.slack_user_id,
      slack_team_id: value.slack_team_id,
      gateway_channel_id: value.gateway_channel_id,
      gateway_config_generation: value.gateway_config_generation,
      slack_channel_id: value.slack_channel_id,
      slack_thread_id: value.slack_thread_id,
      task_id: value.task_id,
      session_id: value.session_id,
      mcp_server_id: value.mcp_server_id,
      mcp_server_config_version: value.mcp_server_config_version,
      recovery_generation: value.recovery_generation,
      recovery_request_id: value.recovery_request_id,
      notice_id: value.notice_id,
      jti: value.token_jti,
      expiresAt: EXPIRES,
    },
    SECRET,
    NOW
  );
}

describe('MCP Slack recovery tokens', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => vi.useRealTimers());

  it('seals an opaque, expiring token and verifies every durable binding', () => {
    const token = issue();
    const claims = verifyMCPSlackRecoveryToken(token, SECRET);
    expect(token).not.toMatch(/tenant-1|user-1|task-1|session-1|server-1|C123|U123|T123/);
    expect(claims.iat).toBe(NOW.getTime() / 1_000);
    expect(claims.exp).toBe(EXPIRES.getTime() / 1_000);
    expect(mcpSlackRecoveryClaimsMatchNotice(claims, notice(), 'tenant-1' as TenantID)).toBe(true);
  });

  it('rejects expiry, forgery, and an unsupported envelope', () => {
    expect(() => verifyMCPSlackRecoveryToken(issue(), SECRET, EXPIRES)).toThrow(/expired/i);
    expect(() => verifyMCPSlackRecoveryToken(issue(), 'different-secret')).toThrow();
    const token = issue();
    const forged = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
    expect(() => verifyMCPSlackRecoveryToken(forged, SECRET)).toThrow();
    expect(() => verifyMCPSlackRecoveryToken('not-an-envelope', SECRET)).toThrow();
  });

  it('rejects cross-tenant, cross-user, and credential-owner caller authority', () => {
    const claims = verifyMCPSlackRecoveryToken(issue(), SECRET);
    expect(mcpSlackRecoveryClaimsMatchCaller(claims, 'tenant-1', 'user-1')).toBe(true);
    expect(mcpSlackRecoveryClaimsMatchCaller(claims, 'tenant-2', 'user-1')).toBe(false);
    expect(mcpSlackRecoveryClaimsMatchCaller(claims, 'tenant-1', 'user-2')).toBe(false);
    expect(
      mcpSlackRecoveryClaimsMatchCaller(
        { ...claims, credential_user_id: 'user-2' as UserID },
        'tenant-1',
        'user-1'
      )
    ).toBe(false);
  });

  it.each([
    ['tenant', (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, tid: 'tenant-2' })],
    ['user', (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, sub: 'user-2' as UserID })],
    ['task', (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, task_id: 'task-2' })],
    [
      'session',
      (claims: MCPSlackRecoveryTokenClaims) => ({
        ...claims,
        session_id: 'session-2' as SessionID,
      }),
    ],
    ['channel', (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, slack_channel_id: 'C999' })],
    [
      'thread',
      (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, slack_thread_id: 'C123-999.1' }),
    ],
    [
      'gateway generation',
      (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, gateway_config_generation: 8 }),
    ],
    [
      'server configuration',
      (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, mcp_server_config_version: 4 }),
    ],
    [
      'recovery generation',
      (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, recovery_generation: 12 }),
    ],
    [
      'request identity',
      (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, recovery_request_id: 'request-2' }),
    ],
    ['single-use identity', (claims: MCPSlackRecoveryTokenClaims) => ({ ...claims, jti: 'jti-2' })],
  ])('rejects a mismatched %s binding', (_name, mutate) => {
    const claims = verifyMCPSlackRecoveryToken(issue(), SECRET);
    expect(
      mcpSlackRecoveryClaimsMatchNotice(mutate(claims), notice(), 'tenant-1' as TenantID)
    ).toBe(false);
  });
});
