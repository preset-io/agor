import { describe, expect, it } from 'vitest';
import { issueMCPEgressCapability, verifyMCPEgressCapability } from './capability.js';

const secret = 'gateway-capability-test-secret';
const claims = {
  tid: 'tenant-a',
  task_id: 'task-a',
  session_id: 'session-a',
  principal_user_id: 'prompter-a',
  credential_user_id: 'owner-a',
  mcp_server_id: 'server-a',
  config_version: 7,
  material_hash: 'opaque-material-binding',
  grant_identity: '3:opaque-grant-binding',
  rollout_mode: 'enforced' as const,
  jti: 'capability-a',
};

describe('MCP egress capability', () => {
  it('is opaque, task-live, and contains no reusable provider credential material', () => {
    const token = issueMCPEgressCapability(claims, secret);
    expect(token).toMatch(/^agor_mcp_cap_v1\.[A-Za-z0-9_-]+$/);
    expect(token).not.toContain(claims.tid);
    expect(token).not.toContain(claims.task_id);
    expect(verifyMCPEgressCapability(token, secret)).toMatchObject(claims);
  });

  it('rejects tampering, the wrong daemon secret, invalid mode, and invalid authority version', () => {
    const token = issueMCPEgressCapability(claims, secret);
    const offset = Math.floor(token.length / 2);
    const replacement = token[offset] === 'A' ? 'B' : 'A';
    expect(() =>
      verifyMCPEgressCapability(
        `${token.slice(0, offset)}${replacement}${token.slice(offset + 1)}`,
        secret
      )
    ).toThrow();
    expect(() => verifyMCPEgressCapability(token, 'other-daemon-secret')).toThrow();
    expect(() =>
      verifyMCPEgressCapability(
        issueMCPEgressCapability({ ...claims, rollout_mode: 'observe' } as never, secret),
        secret
      )
    ).toThrow();
    expect(() =>
      verifyMCPEgressCapability(
        issueMCPEgressCapability({ ...claims, config_version: 0 }, secret),
        secret
      )
    ).toThrow();
  });
});
