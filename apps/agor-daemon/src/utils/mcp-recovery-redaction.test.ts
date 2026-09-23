import type { Message, Task } from '@agor/core/types';
import { describe, expect, it } from 'vitest';
import {
  redactMcpRecoveryTopology,
  stripMcpSlackRecoveryNotice,
  stripWidgetSlackConnectDelivery,
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

describe('stripWidgetSlackConnectDelivery', () => {
  it('keeps the widget the transcript renders and drops its Slack delivery record', () => {
    const message = {
      message_id: 'widget-1',
      type: 'widget_request',
      metadata: {
        widget: {
          widget_type: 'oauth',
          widget_id: 'widget-1',
          status: 'pending',
          params: { serverName: 'Notion', mcpServerId: 'server-1' },
          slack_connect: {
            delivery_id: 'delivery-secret',
            delivery_generation: 3,
            token_jti: 'jti-secret',
            issued_at: '2026-09-16T12:00:00.000Z',
            expires_at: '2026-09-16T12:10:00.000Z',
            oauth_attempt_id: 'attempt-secret',
          },
        },
      },
    } as unknown as Message;

    const stripped = stripWidgetSlackConnectDelivery(message);
    expect(stripped.metadata?.widget?.slack_connect).toBeUndefined();
    expect(stripped.metadata?.widget?.status).toBe('pending');
    expect(stripped.metadata?.widget?.params).toEqual({
      serverName: 'Notion',
      mcpServerId: 'server-1',
    });
    expect(JSON.stringify(stripped)).not.toMatch(/delivery-secret|jti-secret|attempt-secret/);
  });

  it('drops the mint-time sweep marker too, which outlives no delivery record', () => {
    // Set exactly when the card has NOT been posted yet, so stripping only
    // `slack_connect` would publish the one lifecycle field that is present
    // in the window the rest of the record is absent.
    const message = {
      message_id: 'widget-3',
      type: 'widget_request',
      metadata: {
        widget: {
          widget_type: 'oauth',
          widget_id: 'widget-3',
          status: 'pending',
          params: { serverName: 'Notion', mcpServerId: 'server-1' },
          slack_connect_due_at: '2026-09-16T11:59:00.000Z',
        },
      },
    } as unknown as Message;

    const stripped = stripWidgetSlackConnectDelivery(message);
    expect(stripped.metadata?.widget?.slack_connect_due_at).toBeUndefined();
    expect(stripped.metadata?.widget?.status).toBe('pending');
  });

  it('returns an untouched message when there is no delivery record', () => {
    const message = {
      message_id: 'widget-2',
      metadata: { widget: { widget_type: 'env_vars', status: 'pending' } },
    } as unknown as Message;
    expect(stripWidgetSlackConnectDelivery(message)).toBe(message);
    expect(stripWidgetSlackConnectDelivery({ message_id: 'plain' } as Message)).toMatchObject({
      message_id: 'plain',
    });
  });
});
