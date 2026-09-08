import type { SessionRepository } from '@agor/core/db';
import type { HookContext, Task, User } from '@agor/core/types';
import { ROLES } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import { createRedactTaskMcpRecoveryAfter } from './register-hooks.js';

describe('production Task MCP recovery response hook', () => {
  it('keeps context.result authoritative while redacting only the external caller dispatch', async () => {
    const task = {
      task_id: 'task-1',
      session_id: 'session-1',
      created_by: 'collaborator',
      metadata: {
        mcp_recovery: {
          generation: 2,
          code: 'oauth_reauth_required',
          status: 'action_required',
          task_id: 'task-1',
          session_id: 'session-1',
          mcp_server_id: 'private-server-id',
          mcp_server_name: 'Private CRM',
          provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
          action: 'reauthenticate',
          message: 'Sign in again.',
          observed_at: '2026-08-26T00:00:00.000Z',
          provider_dispatch: 'not_started',
        },
      },
    } as Task;
    const hook = createRedactTaskMcpRecoveryAfter({
      findById: async () => ({ created_by: 'owner' }),
    } as Pick<SessionRepository, 'findById'>);
    const context = {
      event: 'patched',
      method: 'patch',
      params: {
        provider: 'socketio',
        user: { user_id: 'collaborator', role: ROLES.MEMBER } as User,
      },
      result: task,
    } as HookContext;

    const returned = await hook(context);

    expect(returned.result).toBe(task);
    expect(JSON.stringify(returned.result)).toContain('Private CRM');
    expect(returned.dispatch).not.toBe(task);
    expect(JSON.stringify(returned.dispatch)).not.toContain('Private CRM');
  });

  it('strips Slack action authority from an admin transport response without mutating the row', async () => {
    const task = {
      task_id: 'task-1',
      session_id: 'session-1',
      created_by: 'owner',
      metadata: {
        mcp_slack_recovery_notice: {
          notice_id: 'notice-secret',
          token_jti: 'jti-secret',
          slack_thread_id: 'C1-1.1',
        },
        gateway_task_source: {
          gateway_channel_id: 'gateway-secret',
          channel_type: 'slack',
          thread_id: 'C1-1.1',
        },
      },
    } as unknown as Task;
    const hook = createRedactTaskMcpRecoveryAfter({
      findById: async () => ({ created_by: 'owner' }),
    } as Pick<SessionRepository, 'findById'>);
    const context = {
      event: 'patched',
      method: 'patch',
      params: {
        provider: 'socketio',
        user: { user_id: 'admin', role: ROLES.ADMIN } as User,
      },
      result: task,
    } as HookContext;

    const returned = await hook(context);

    expect(returned.result).toBe(task);
    expect(JSON.stringify(returned.result)).toContain('notice-secret');
    expect(JSON.stringify(returned.dispatch)).not.toMatch(
      /notice-secret|jti-secret|gateway-secret/
    );
  });
});
