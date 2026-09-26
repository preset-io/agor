import { sealBoundSecret } from '@agor/core/db';
import type {
  MCPOAuthConnectTokenClaims,
  MCPServerID,
  MCPSlackConnectDelivery,
  MessageID,
  SessionID,
  TenantID,
  UserID,
} from '@agor/core/types';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  issueMCPOAuthConnectToken,
  MCP_OAUTH_CONNECT_TOKEN_TTL_MS,
  mcpOAuthConnectClaimsMatchCaller,
  mcpOAuthConnectClaimsMatchDelivery,
  verifyMCPOAuthConnectToken,
} from './mcp-oauth-connect-token.js';
import { issueMCPSlackRecoveryToken } from './mcp-slack-recovery-token.js';

const SECRET = 'test-secret-with-enough-entropy';
const NOW = new Date('2026-09-16T12:00:00.000Z');
const EXPIRES = new Date(NOW.getTime() + MCP_OAUTH_CONNECT_TOKEN_TTL_MS);

function delivery(): MCPSlackConnectDelivery {
  return {
    delivery_id: 'delivery-1',
    delivery_generation: 2,
    token_jti: 'jti-1',
    issued_at: NOW.toISOString(),
    expires_at: EXPIRES.toISOString(),
  };
}

function claimsInput(
  value = delivery()
): Omit<MCPOAuthConnectTokenClaims, 'aud' | 'iss' | 'iat' | 'exp'> {
  return {
    type: 'mcp-oauth-connect',
    tid: 'tenant-1',
    sub: 'user-1' as UserID,
    credential_user_id: 'user-1' as UserID,
    slack_user_id: 'U123',
    slack_team_id: 'T123',
    gateway_channel_id: 'gateway-1',
    gateway_config_generation: 7,
    slack_channel_id: 'C123',
    slack_thread_id: 'C123-1724688000.000100',
    task_id: 'task-1',
    session_id: 'session-1' as SessionID,
    session_owner_user_id: 'user-1' as UserID,
    widget_id: 'widget-1' as MessageID,
    mcp_server_id: 'server-1' as MCPServerID,
    mcp_server_config_version: 3,
    oauth_mode: 'per_user',
    delivery_id: value.delivery_id,
    delivery_generation: value.delivery_generation,
    jti: value.token_jti,
  };
}

function issue(expiresAt = EXPIRES, now = NOW): string {
  return issueMCPOAuthConnectToken({ ...claimsInput(), expiresAt }, SECRET, now);
}

describe('MCP OAuth connect tokens', () => {
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterAll(() => vi.useRealTimers());

  it('seals an opaque, expiring token and verifies its delivery binding', () => {
    const token = issue();
    const claims = verifyMCPOAuthConnectToken(token, SECRET);
    expect(token).not.toMatch(/tenant-1|user-1|task-1|session-1|server-1|widget-1|C123|U123|T123/);
    expect(claims.iat).toBe(NOW.getTime() / 1_000);
    expect(claims.exp).toBe(EXPIRES.getTime() / 1_000);
    expect(claims.widget_id).toBe('widget-1');
    expect(mcpOAuthConnectClaimsMatchDelivery(claims, delivery(), 'tenant-1' as TenantID)).toBe(
      true
    );
  });

  it('caps the lifetime at issue and on read', () => {
    const tooLong = new Date(NOW.getTime() + MCP_OAUTH_CONNECT_TOKEN_TTL_MS + 1_000);
    expect(() => issue(tooLong)).toThrow(/permitted maximum/i);
    expect(() => issue(NOW)).toThrow(/lifetime is invalid/i);
    // A token whose sealed lifetime exceeds the ceiling is refused even though
    // its envelope authenticates: the cap is the type's, not a call site's, so
    // it must hold for an envelope this deployment did not mint through the
    // issuer. Sealed directly with the same purpose/binding to prove that.
    const forgedLongLife = sealBoundSecret(
      JSON.stringify({
        ...claimsInput(),
        iat: Math.floor(NOW.getTime() / 1_000),
        exp: Math.floor(tooLong.getTime() / 1_000),
        aud: 'agor:mcp-oauth-connect',
        iss: 'agor',
      }),
      SECRET,
      'slack-mcp-connect',
      'agor:mcp-oauth-connect:v1'
    );
    expect(() => verifyMCPOAuthConnectToken(forgedLongLife, SECRET)).toThrow(/permitted maximum/i);
  });

  it('rejects expiry, forgery, and an unsupported envelope', () => {
    expect(() => verifyMCPOAuthConnectToken(issue(), SECRET, EXPIRES)).toThrow(/expired/i);
    expect(() => verifyMCPOAuthConnectToken(issue(), 'different-secret')).toThrow();
    const token = issue();
    const ciphertextOffset = token.lastIndexOf(':') + 1;
    const ciphertext = Buffer.from(token.slice(ciphertextOffset), 'base64url');
    ciphertext[0] ^= 1;
    const forged = `${token.slice(0, ciphertextOffset)}${ciphertext.toString('base64url')}`;
    expect(() => verifyMCPOAuthConnectToken(forged, SECRET)).toThrow();
    expect(() => verifyMCPOAuthConnectToken('not-an-envelope', SECRET)).toThrow();
  });

  it('refuses a recovery token sealed with the same deployment secret', () => {
    // The whole point of a separate audience and envelope binding: one lane's
    // token must never satisfy the other lane's verifier.
    const recoveryToken = issueMCPSlackRecoveryToken(
      {
        type: 'mcp-slack-recovery',
        tid: 'tenant-1',
        sub: 'user-1' as UserID,
        credential_user_id: 'user-1' as UserID,
        slack_user_id: 'U123',
        slack_team_id: 'T123',
        gateway_channel_id: 'gateway-1',
        gateway_config_generation: 7,
        slack_channel_id: 'C123',
        slack_thread_id: 'C123-1724688000.000100',
        task_id: 'task-1',
        session_id: 'session-1' as SessionID,
        mcp_server_id: 'server-1' as MCPServerID,
        mcp_server_config_version: 3,
        recovery_generation: 1,
        notice_id: 'notice-1',
        jti: 'jti-1',
        expiresAt: EXPIRES,
      },
      SECRET,
      NOW
    );
    expect(() => verifyMCPOAuthConnectToken(recoveryToken, SECRET)).toThrow();
  });

  it('requires the redeemer to be both principal and credential owner', () => {
    const claims = verifyMCPOAuthConnectToken(issue(), SECRET);
    expect(mcpOAuthConnectClaimsMatchCaller(claims, 'tenant-1', 'user-1')).toBe(true);
    expect(mcpOAuthConnectClaimsMatchCaller(claims, 'tenant-2', 'user-1')).toBe(false);
    expect(mcpOAuthConnectClaimsMatchCaller(claims, 'tenant-1', 'user-2')).toBe(false);
    expect(mcpOAuthConnectClaimsMatchCaller(claims, undefined, 'user-1')).toBe(false);
    expect(mcpOAuthConnectClaimsMatchCaller(claims, 'tenant-1', undefined)).toBe(false);
    expect(
      mcpOAuthConnectClaimsMatchCaller(
        { ...claims, credential_user_id: 'user-2' as UserID },
        'tenant-1',
        'user-1'
      )
    ).toBe(false);
  });

  it.each([
    ['tenant', (claims: MCPOAuthConnectTokenClaims) => ({ ...claims, tid: 'tenant-2' })],
    [
      'delivery identity',
      (claims: MCPOAuthConnectTokenClaims) => ({ ...claims, delivery_id: 'delivery-2' }),
    ],
    [
      'delivery generation',
      (claims: MCPOAuthConnectTokenClaims) => ({ ...claims, delivery_generation: 3 }),
    ],
    ['single-use identity', (claims: MCPOAuthConnectTokenClaims) => ({ ...claims, jti: 'jti-2' })],
    ['issue epoch', (claims: MCPOAuthConnectTokenClaims) => ({ ...claims, iat: claims.iat + 1 })],
    ['expiry', (claims: MCPOAuthConnectTokenClaims) => ({ ...claims, exp: claims.exp + 1 })],
  ])('rejects a mismatched %s binding', (_name, mutate) => {
    const claims = verifyMCPOAuthConnectToken(issue(), SECRET);
    expect(
      mcpOAuthConnectClaimsMatchDelivery(mutate(claims), delivery(), 'tenant-1' as TenantID)
    ).toBe(false);
  });

  it('rejects an absent delivery record outright', () => {
    const claims = verifyMCPOAuthConnectToken(issue(), SECRET);
    expect(mcpOAuthConnectClaimsMatchDelivery(claims, undefined, 'tenant-1' as TenantID)).toBe(
      false
    );
  });
});
