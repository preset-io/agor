import { runWithTenantContext } from '@agor/core/db';
import type { MCPSlackRecoveryNotice, Task } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  GatewayService,
  mcpSlackRecoveryExpiryDelay,
  mcpSlackRecoveryMessageCopy,
  mcpSlackRecoveryRenderedState,
  taskMayNeedMcpSlackRecoverySync,
} from './gateway.js';

const expiresAt = '2026-08-26T12:10:00.000Z';
const now = Date.parse('2026-08-26T12:00:00.000Z');

function notice(overrides: Partial<MCPSlackRecoveryNotice> = {}): MCPSlackRecoveryNotice {
  return {
    notice_id: 'notice-1',
    token_jti: 'jti-1',
    issued_at: '2026-08-26T12:00:00.000Z',
    expires_at: expiresAt,
    principal_user_id: 'user-1',
    credential_user_id: 'user-1',
    slack_user_id: 'U1',
    slack_team_id: 'T1',
    gateway_channel_id: 'gateway-1',
    gateway_config_generation: 1,
    slack_channel_id: 'C1',
    slack_thread_id: 'C1-1.1',
    session_id: 'session-1',
    task_id: 'task-1',
    mcp_server_id: 'server-1' as never,
    mcp_server_config_version: 1,
    recovery_generation: 4,
    recovery_request_id: 'request-1',
    provider_dispatch: 'not_started',
    delivery_id: 'delivery-1',
    ...overrides,
  };
}

function task(overrides: Record<string, unknown> = {}): Task {
  return {
    task_id: 'task-1',
    session_id: 'session-1',
    status: TaskStatus.RUNNING,
    metadata: {
      mcp_recovery_generation: 4,
      mcp_recovery: {
        generation: 4,
        code: 'oauth_reauth_required',
        status: 'action_required',
        task_id: 'task-1',
        session_id: 'session-1',
        mcp_server_id: 'server-1',
        provider: { mode: 'in_place', transport_reload: true, retries_unstarted_call: false },
        action: 'reauthenticate',
        message: 'redacted',
        observed_at: '2026-08-26T12:00:00.000Z',
        request_id: 'request-1',
        provider_dispatch: 'not_started',
      },
    },
    ...overrides,
  } as Task;
}

describe('Slack MCP recovery presentation', () => {
  it('projects every durable lifecycle state without provider errors', () => {
    expect(mcpSlackRecoveryRenderedState(task(), notice(), now)).toBe('reconnect_required');
    expect(
      mcpSlackRecoveryRenderedState(
        task(),
        notice({ oauth_started_at: new Date(now).toISOString() }),
        now
      )
    ).toBe('sign_in_pending');
    expect(
      mcpSlackRecoveryRenderedState(
        task(),
        notice({ oauth_failed_at: new Date(now).toISOString() }),
        now
      )
    ).toBe('failed');
    expect(mcpSlackRecoveryRenderedState(task(), notice(), Date.parse(expiresAt) + 1)).toBe(
      'expired_or_superseded'
    );
    expect(
      mcpSlackRecoveryRenderedState(
        task({
          metadata: {
            mcp_recovery_generation: 4,
            mcp_recovery_settled_request_id: 'request-1',
            mcp_recovery_settled_at: new Date(now).toISOString(),
          },
        }),
        notice({ oauth_succeeded_at: new Date(now).toISOString() }),
        now
      )
    ).toBe('recovered');
    expect(
      mcpSlackRecoveryRenderedState(
        task({
          metadata: {
            mcp_recovery: {
              ...task().metadata?.mcp_recovery,
              code: 'rollout_changed',
              action: 'retry_next_turn',
            },
          },
        }),
        notice(),
        now
      )
    ).toBe('manual_next_turn');
  });

  it('requires durable settlement evidence when a request id is absent', () => {
    const requestless = notice({ recovery_request_id: undefined });
    const succeeded = { ...requestless, oauth_succeeded_at: new Date(now).toISOString() };
    expect(
      mcpSlackRecoveryRenderedState(
        task({ metadata: { mcp_recovery_generation: 4 } }),
        succeeded,
        now
      )
    ).toBe('sign_in_pending');
    expect(
      mcpSlackRecoveryRenderedState(
        task({
          metadata: {
            mcp_recovery_generation: 4,
            mcp_recovery_settled_at: new Date(now).toISOString(),
          },
        }),
        succeeded,
        now
      )
    ).toBe('recovered');
  });

  it('renders provider success after authority drift as superseded, never failed', () => {
    expect(
      mcpSlackRecoveryRenderedState(
        task(),
        notice({ oauth_superseded_at: new Date(now).toISOString() }),
        now
      )
    ).toBe('expired_or_superseded');
  });

  it('never schedules terminal or already-expired expiry notices', () => {
    expect(mcpSlackRecoveryExpiryDelay('expired_or_superseded', notice(), now)).toBeUndefined();
    expect(mcpSlackRecoveryExpiryDelay('failed', notice(), now)).toBeUndefined();
    expect(
      mcpSlackRecoveryExpiryDelay('reconnect_required', notice(), Date.parse(expiresAt))
    ).toBeUndefined();
    expect(mcpSlackRecoveryExpiryDelay('reconnect_required', notice(), now)).toBe(601_000);
  });

  it('creates no process timer for terminal or expired notices', () => {
    vi.useFakeTimers();
    try {
      const service = new GatewayService({ run: vi.fn() } as never, {} as never);
      const schedule = (
        service as unknown as {
          scheduleMcpSlackRecoveryExpiry(
            taskId: string,
            value: MCPSlackRecoveryNotice,
            state: 'expired_or_superseded' | 'reconnect_required'
          ): void;
        }
      ).scheduleMcpSlackRecoveryExpiry.bind(service);
      schedule('task-1', notice(), 'expired_or_superseded');
      schedule(
        'task-1',
        notice({ expires_at: new Date(now - 1).toISOString() }),
        'reconnect_required'
      );
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('guards global task events before recovery synchronization', () => {
    expect(taskMayNeedMcpSlackRecoverySync({ task_id: 'ordinary' })).toBe(false);
    expect(taskMayNeedMcpSlackRecoverySync(task())).toBe(false);
    expect(
      taskMayNeedMcpSlackRecoverySync({
        ...task(),
        metadata: {
          ...task().metadata,
          gateway_task_source: { channel_type: 'slack' },
        },
      })
    ).toBe(true);
    expect(
      taskMayNeedMcpSlackRecoverySync({
        metadata: { mcp_slack_recovery_notice: notice() },
      })
    ).toBe(true);
  });

  it('distinguishes known-not-started from ambiguous calls and never offers automatic replay', () => {
    const known = mcpSlackRecoveryMessageCopy('recovered', 'not_started').text;
    const ambiguous = mcpSlackRecoveryMessageCopy('recovered', 'ambiguous').text;
    expect(known).toMatch(/explicitly ask.*retry/i);
    expect(ambiguous).toMatch(/may have started.*not replayed/i);
    for (const state of [
      'reconnect_required',
      'sign_in_pending',
      'recovered',
      'expired_or_superseded',
      'failed',
      'manual_next_turn',
    ] as const) {
      const copy = mcpSlackRecoveryMessageCopy(state, 'ambiguous').text;
      expect(copy).not.toMatch(/automatically retr(y|ied)|provider error|access[_ -]?token/i);
    }
  });
});

describe('Slack MCP recovery durable delivery', () => {
  function deliveryHarness(sendMessage: ReturnType<typeof vi.fn>) {
    let currentTask = task({
      metadata: {
        ...task().metadata,
        mcp_slack_recovery_notice: notice({
          expires_at: new Date(now - 1).toISOString(),
          next_repair_at: new Date(now).toISOString(),
        }),
      },
    });
    const service = new GatewayService({ run: vi.fn() } as never, {} as never);
    const findMessageByMetadata = vi.fn(async () => '1700000000.000002');
    const connector = { channelType: 'slack' as const, findMessageByMetadata, sendMessage };
    const mutateMCPSlackRecoveryNotice = vi.fn(
      async (
        _taskId: string,
        build: (
          current: MCPSlackRecoveryNotice | undefined,
          locked: Task
        ) => MCPSlackRecoveryNotice | null | Promise<MCPSlackRecoveryNotice | null>
      ) => {
        const next = await build(currentTask.metadata?.mcp_slack_recovery_notice, currentTask);
        if (!next) return { task: currentTask, changed: false };
        currentTask = {
          ...currentTask,
          metadata: { ...currentTask.metadata, mcp_slack_recovery_notice: next },
        };
        return { task: currentTask, changed: true };
      }
    );
    Object.assign(service as unknown as Record<string, unknown>, {
      taskRepo: { mutateMCPSlackRecoveryNotice },
      channelRepo: {
        findById: vi.fn(async () => ({
          id: 'gateway-1',
          enabled: true,
          channel_type: 'slack',
          provider_config_generation: 1,
          config: { bot_token: 'redacted', allowed_channel_ids: ['C1'] },
        })),
      },
      activeListeners: new Map([['tenant-a\0gateway-1', connector]]),
    });
    const deliver = () =>
      runWithTenantContext('tenant-a', () =>
        (
          service as unknown as { deliverMcpSlackRecoveryNotice(value: Task): Promise<void> }
        ).deliverMcpSlackRecoveryNotice(currentTask)
      );
    return {
      service,
      deliver,
      findMessageByMetadata,
      current: () => currentTask.metadata?.mcp_slack_recovery_notice,
    };
  }

  it('reconciles a crash-after-send claim before posting again', async () => {
    const sendMessage = vi.fn(async (request: { metadata?: Record<string, unknown> }) => {
      expect(request.metadata).toMatchObject({ slack_update_ts: '1700000000.000002' });
      expect(request.metadata).not.toHaveProperty('slack_message_metadata');
      return '1700000000.000002';
    });
    const harness = deliveryHarness(sendMessage);

    await harness.deliver();

    expect(harness.findMessageByMetadata).toHaveBeenCalledOnce();
    expect(sendMessage).toHaveBeenCalledOnce();
    expect(harness.current()).toMatchObject({
      slack_message_ts: '1700000000.000002',
      rendered_state: 'expired_or_superseded',
    });
    expect(harness.current()?.next_repair_at).toBeUndefined();
  });

  it('retries a terminal projection within a durable window after browser expiry', async () => {
    const harness = deliveryHarness(vi.fn(async () => Promise.reject(new Error('provider'))));

    await harness.deliver();

    expect(harness.current()).toMatchObject({
      delivery_attempt_count: 1,
      delivery_last_failed_at: expect.any(String),
      delivery_next_retry_at: expect.any(String),
      delivery_retry_until: expect.any(String),
      next_repair_at: expect.any(String),
    });
    await harness.service.stopListeners();
  });
});
