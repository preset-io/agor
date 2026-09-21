import {
  createDatabaseAsync,
  createTenantScopedDatabaseProxy,
  getMCPEgressGatewayMode,
  runMigrations,
  runWithTenantContext,
} from '@agor/core/db';
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
  function deliveryHarness(
    sendMessage: ReturnType<typeof vi.fn>,
    noticeOverrides: Partial<MCPSlackRecoveryNotice> = {}
  ) {
    let currentTask = task({
      metadata: {
        ...task().metadata,
        mcp_slack_recovery_notice: notice({
          expires_at: new Date(now - 1).toISOString(),
          next_repair_at: new Date(now).toISOString(),
          ...noticeOverrides,
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

  /**
   * The bounded repair sweep holds tenant CONTEXT and no tenant database
   * SCOPE. `syncMcpSlackRecoveryNotice` reads two app-variable settings on its
   * first line, and neither goes through a repository bound to a tenant unit
   * of work — so against the production guard both threw
   * `MissingTenantDatabaseScopeError` into the sweep's `.catch(() =>
   * undefined)`, and this lane's repair path has never repaired anything.
   *
   * A missing task is enough to prove it: the settings are read BEFORE the
   * task lookup, so the call either gets past them or it does not.
   */
  it('reads its settings inside a scope, on a caller that holds only tenant context', async () => {
    const rawDb = await createDatabaseAsync({ dialect: 'sqlite', url: ':memory:' });
    await runMigrations(rawDb);
    const guarded = createTenantScopedDatabaseProxy(rawDb, {
      requireScope: true,
      label: 'recovery notice scope guard',
    });
    await expect(getMCPEgressGatewayMode(guarded)).rejects.toThrow(/tenant database scope/i);

    const service = new GatewayService(guarded as never, {} as never);
    Object.assign(service as unknown as Record<string, unknown>, {
      taskRepo: { findById: async () => null },
    });
    await expect(
      runWithTenantContext('tenant-a', () => service.syncMcpSlackRecoveryNotice('missing-task'))
    ).resolves.toBeUndefined();
    await service.stopListeners();
  });

  /**
   * D2 on this lane: an unbuildable base URL withholds the BUTTON, it does not
   * throw the delivery away.
   *
   * `mcpSlackRecoveryUrl` threw on an empty base URL, which is the same shape
   * D1 closed on the connect lane: the throw lands above the settlement CAS
   * while this pass holds the claim, so the notice's overdue `next_repair_at`
   * brought it around the sweep every thirty seconds and nothing said why.
   * `undefined` is what this lane has always answered for an absent
   * `AGOR_MASTER_SECRET` and for a consumed token — the card goes out, without
   * a button — and an unusable public URL is the same kind of fact.
   */
  it('posts a recovery card without a button when no public URL can be built', async () => {
    const previousSecret = process.env.AGOR_MASTER_SECRET;
    const previousBaseUrl = process.env.AGOR_BASE_URL;
    process.env.AGOR_MASTER_SECRET = 'recovery-no-public-url-test-secret';
    // The static fallback a deployment that never configured a public URL
    // gets: a perfectly well-formed URL that works for nobody in the thread.
    process.env.AGOR_BASE_URL = 'http://localhost:3030';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sendMessage = vi.fn(async () => '1700000000.000003');
      const harness = deliveryHarness(sendMessage, {
        // Live, so the rendered state is `reconnect_required` — the one state
        // that offers a link at all.
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        next_repair_at: new Date().toISOString(),
      });

      // A card, not an exception.
      await harness.deliver();

      expect(sendMessage).toHaveBeenCalledOnce();
      const blocks = (sendMessage.mock.calls[0]![0] as { blocks: { type: string }[] }).blocks;
      expect(blocks.some((block) => block.type === 'actions')).toBe(false);
      // And the card settled rather than leaking its claim.
      expect(harness.current()?.delivery_claim).toBeUndefined();
      expect(harness.current()?.rendered_state).toBe('reconnect_required');
      expect(
        warn.mock.calls.some(
          (call) =>
            typeof call[0] === 'string' &&
            call[0].includes('lane=recovery') &&
            call[0].includes('reason=no_public_url')
        )
      ).toBe(true);
      await harness.service.stopListeners();
    } finally {
      warn.mockRestore();
      if (previousSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previousSecret;
      if (previousBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
      else process.env.AGOR_BASE_URL = previousBaseUrl;
    }
  });

  it('posts a recovery card whose button is on the deployment public origin', async () => {
    const previousSecret = process.env.AGOR_MASTER_SECRET;
    const previousBaseUrl = process.env.AGOR_BASE_URL;
    process.env.AGOR_MASTER_SECRET = 'recovery-public-url-test-secret';
    process.env.AGOR_BASE_URL = 'https://agor.example.test';
    try {
      const sendMessage = vi.fn(async () => '1700000000.000004');
      const harness = deliveryHarness(sendMessage, {
        expires_at: new Date(Date.now() + 600_000).toISOString(),
        next_repair_at: new Date().toISOString(),
      });

      await harness.deliver();

      const blocks = (
        sendMessage.mock.calls[0]![0] as {
          blocks: { type: string; elements?: { url?: string }[] }[];
        }
      ).blocks;
      const url = blocks.find((block) => block.type === 'actions')?.elements?.[0]?.url;
      expect(url).toMatch(/#token=/);
      expect(new URL(url as string).origin).toBe('https://agor.example.test');
      await harness.service.stopListeners();
    } finally {
      if (previousSecret === undefined) delete process.env.AGOR_MASTER_SECRET;
      else process.env.AGOR_MASTER_SECRET = previousSecret;
      if (previousBaseUrl === undefined) delete process.env.AGOR_BASE_URL;
      else process.env.AGOR_BASE_URL = previousBaseUrl;
    }
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
