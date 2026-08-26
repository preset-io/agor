import type { Task } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  redactMcpRecoveryTopology,
  stripMcpSlackRecoveryNotice,
} from './mcp-recovery-redaction.js';

describe('redactMcpRecoveryTopology', () => {
  it('retains the action while removing server ids and names', () => {
    const task = {
      task_id: 'task-1',
      metadata: {
        mcp_recovery: {
          generation: 2,
          code: 'oauth_reauth_required',
          status: 'action_required',
          task_id: 'task-1',
          session_id: 'session-1',
          mcp_server_id: 'server-secret-topology',
          mcp_server_name: 'Private CRM',
          server_states: [
            {
              mcp_server_id: 'server-secret-topology',
              name: 'Private CRM',
              code: 'oauth_reauth_required',
              action: 'reauthenticate',
              message: 'Sign in.',
            },
          ],
          provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
          action: 'reauthenticate',
          message: 'Sign in again.',
          observed_at: '2026-08-26T00:00:00.000Z',
          provider_dispatch: 'not_started',
        },
      },
    } as Task;

    const redacted = redactMcpRecoveryTopology(task);
    expect(redacted.metadata?.mcp_recovery).toMatchObject({
      action: 'reauthenticate',
      code: 'oauth_reauth_required',
    });
    expect(redacted.metadata?.mcp_recovery?.mcp_server_id).toBeUndefined();
    expect(redacted.metadata?.mcp_recovery?.server_states).toBeUndefined();
    expect(JSON.stringify(redacted)).not.toContain('Private CRM');
    expect(JSON.stringify(redacted)).not.toContain('server-secret-topology');
  });
});

describe('stripMcpSlackRecoveryNotice', () => {
  it('never exposes the signed action identity or Slack routing topology', () => {
    const task = {
      task_id: 'task-1',
      metadata: {
        mcp_slack_recovery_notice: {
          notice_id: 'notice-secret',
          token_jti: 'jti-secret',
          slack_thread_id: 'C1-1.1',
          slack_user_id: 'U1',
        },
        gateway_task_source: {
          gateway_channel_id: 'gateway-secret',
          channel_type: 'slack',
          thread_id: 'C1-1.1',
          provider_user_id: 'U1',
        },
        caller_metadata: { safe: true },
      },
    } as unknown as Task;

    const stripped = stripMcpSlackRecoveryNotice(task);
    expect(stripped.metadata?.mcp_slack_recovery_notice).toBeUndefined();
    expect(stripped.metadata?.caller_metadata).toEqual({ safe: true });
    expect(stripped.metadata?.gateway_task_source).toBeUndefined();
    expect(JSON.stringify(stripped)).not.toMatch(
      /notice-secret|jti-secret|gateway-secret|C1-1\.1|U1/
    );
  });
});
