import type { Task } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { redactMcpRecoveryTopology } from './mcp-recovery-redaction.js';

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
