import { describe, expect, it } from 'vitest';
import {
  consumeMcpRefreshAttempt,
  MCP_REFRESH_LIMITER_KEY_CAP,
  MCP_RUNTIME_HINT_TASK_BUDGET,
  type MCPRefreshAttemptState,
} from './mcp-refresh-limiter.js';

describe('MCP refresh availability limiter', () => {
  it('keeps capacity after a full fanout burst and always admits an exact durable retry', () => {
    const state: MCPRefreshAttemptState = new Map();
    const consume = (authorityKey: string, isExactDurableRetry = false) =>
      consumeMcpRefreshAttempt(state, {
        tenantId: 'tenant-a',
        authorityKey,
        now: 1_000,
        isExactDurableRetry,
      });

    for (let index = 0; index < MCP_RUNTIME_HINT_TASK_BUDGET; index += 1) {
      expect(consume(`fanout-task-${index}`)).toBe('allowed');
    }
    expect(consume('legitimate-task-after-fanout')).toBe('allowed');

    for (
      let index = MCP_RUNTIME_HINT_TASK_BUDGET + 1;
      index < MCP_REFRESH_LIMITER_KEY_CAP;
      index += 1
    ) {
      expect(consume(`additional-task-${index}`)).toBe('allowed');
    }
    expect(consume('over-capacity')).toBe('key_capacity');
    expect(consume('exact-durable-retry', true)).toBe('allowed');
  });

  it('bounds per-key attempts but admits the key again after the local window expires', () => {
    const state: MCPRefreshAttemptState = new Map();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(
        consumeMcpRefreshAttempt(state, {
          tenantId: 'tenant-a',
          authorityKey: 'principal:task',
          now: 2_000 + attempt,
          isExactDurableRetry: false,
        })
      ).toBe('allowed');
    }
    expect(
      consumeMcpRefreshAttempt(state, {
        tenantId: 'tenant-a',
        authorityKey: 'principal:task',
        now: 2_010,
        isExactDurableRetry: false,
      })
    ).toBe('rate_limited');
    expect(
      consumeMcpRefreshAttempt(state, {
        tenantId: 'tenant-a',
        authorityKey: 'principal:task',
        now: 12_005,
        isExactDurableRetry: false,
      })
    ).toBe('allowed');
  });
});
