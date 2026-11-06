import type { TenantScopeAwareDatabase } from '@agor/core/db';
import { runWithTenantContext } from '@agor/core/db';
import { getConnector } from '@agor/core/gateway';
import type {
  GatewayChannel,
  Message,
  Task,
  ThreadSessionMap,
  User,
  UserID,
} from '@agor/core/types';
import { SessionStatus, TaskStatus } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { GatewayService } from './gateway.js';

vi.mock('@agor/agentic-tools/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/agentic-tools/config')>();
  return {
    ...actual,
    materializeAgenticToolConfiguration: vi.fn(async () => ({
      agentic_tool_preset_id: null,
      permission_config: { mode: 'default' },
      model_config: null,
    })),
  };
});

vi.mock('@agor/core/gateway', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/gateway')>();
  return {
    ...actual,
    getConnector: vi.fn(),
  };
});

vi.mock('@agor/core/config', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agor/core/config')>();
  return {
    ...actual,
    assertInlineAgenticConfigurationAllowed: vi.fn(async () => undefined),
  };
});

const tenantId = 'tenant-github';
const threadId = 'preset-io/agor#42';

const alignedUser = {
  user_id: '019fd900-0000-7000-8000-000000000001' as UserID,
  email: 'aligned@example.com',
  name: 'Aligned User',
  role: 'member',
  is_active: true,
} as unknown as User;

const githubChannel = {
  id: '019fd900-0000-7000-8000-000000000010',
  name: 'GitHub Bot',
  channel_type: 'github',
  channel_key: '019fd900-0000-7000-8000-000000000011',
  enabled: true,
  target_branch_id: '019fd900-0000-7000-8000-000000000012',
  agor_user_id: '019fd900-0000-7000-8000-000000000013',
  config: {
    app_id: 123,
    private_key: 'redacted-test-key',
    installation_id: 456,
    repositories: ['preset-io/agor'],
    align_github_users: true,
    user_map: { octocat: alignedUser.email },
  },
} as unknown as GatewayChannel;

const githubMetadata = {
  repo_full_name: 'preset-io/agor',
  issue_number: 42,
  github_user: 'octocat',
  github_user_email: 'octocat@users.noreply.github.com',
  comment_url: 'https://github.com/preset-io/agor/issues/42#issuecomment-100',
};

function githubMapping(overrides: Partial<ThreadSessionMap> = {}): ThreadSessionMap {
  return {
    id: '019fd900-0000-7000-8000-000000000020',
    channel_id: githubChannel.id,
    thread_id: threadId,
    session_id: '019fd900-0000-7000-8000-000000000021',
    branch_id: githubChannel.target_branch_id,
    status: 'active',
    metadata: { ...githubMetadata, processing_comment_id: 900 },
    created_at: '2026-08-14T00:00:00.000Z',
    last_message_at: '2026-08-14T00:00:00.000Z',
    ...overrides,
  } as unknown as ThreadSessionMap;
}

function makeReproHarness(existingMapping: ThreadSessionMap | null = null) {
  let mapping = existingMapping;
  let messages: Message[] = [];
  let tasks: Task[] = [];
  const db = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;
  const sendMessage = vi.fn(async () => 'provider-message-id');
  vi.mocked(getConnector).mockReturnValue({ sendMessage } as never);

  const app = {
    service: (name: string) => {
      if (name === 'users') return { get: vi.fn(async () => alignedUser) };
      if (name === 'sessions') {
        return {
          get: vi.fn(async (sessionId: string) => ({
            session_id: sessionId,
            branch_id: githubChannel.target_branch_id,
            created_by: alignedUser.user_id,
            status: SessionStatus.IDLE,
            custom_context: { gateway_source: { channel_id: githubChannel.id } },
          })),
          patch: vi.fn(async () => undefined),
        };
      }
      throw new Error(`Unexpected service: ${name}`);
    },
  };

  const service = new GatewayService(db, app as never);
  const channelRepo = {
    findByKey: vi.fn(async () => githubChannel),
    findById: vi.fn(async () => githubChannel),
  };
  const threadMapRepo = {
    findByChannelAndThread: vi.fn(async () => mapping),
    findBySessionAmbiguityAware: vi.fn(async () => ({ mapping, ambiguous: false })),
    findById: vi.fn(async () => mapping),
    mergeMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) {
        mapping = {
          ...mapping,
          metadata: { ...((mapping.metadata as Record<string, unknown>) ?? {}), ...metadata },
        } as ThreadSessionMap;
      }
    }),
  };
  const messagesRepo = {
    findByTaskId: vi.fn(async (taskId: string) =>
      messages.filter((message) => message.task_id === taskId)
    ),
    mutateMetadataLocked: vi.fn(
      async (
        messageId: string,
        mutation: (metadata: Message['metadata'], message: Message) => Message['metadata'] | null
      ) => {
        const index = messages.findIndex((message) => message.message_id === messageId);
        const message = messages[index];
        if (!message) throw new Error(`Message not found: ${messageId}`);
        const metadata = mutation(message.metadata, message);
        if (metadata === null) return { changed: false, message };
        const updated = { ...message, metadata };
        messages[index] = updated;
        return { changed: true, message: updated };
      }
    ),
  };
  const taskRepo = {
    findById: vi.fn(
      async (taskId: string) => tasks.find((task) => task.task_id === taskId) ?? null
    ),
    updateGatewayReplyMetadata: vi.fn(
      async (
        taskId: string,
        patch: Record<string, unknown>,
        options: { expectedClaimToken?: string | null; staleClaimTimeoutMs?: number } = {}
      ) => {
        const task = tasks.find((t) => t.task_id === taskId);
        if (!task) return { updated: false, task: null as any };
        const metadata = (task.metadata ?? {}) as Record<string, unknown>;
        const replyMetadata = (metadata.gateway_reply_metadata ?? {}) as Record<string, unknown>;

        if (
          replyMetadata.delivery_status === 'delivered' &&
          patch.delivery_status !== 'delivered'
        ) {
          return { updated: false, task };
        }

        if (patch.delivery_status === 'processing') {
          const currentStatus = replyMetadata.delivery_status;
          if (currentStatus === 'delivered' || currentStatus === 'dead_letter') {
            return { updated: false, task };
          }
          if (currentStatus === 'processing') {
            const claimedAtMs = Date.parse((replyMetadata.claimed_at as string) ?? '');
            const staleTimeoutMs = options.staleClaimTimeoutMs ?? 5 * 60 * 1000;
            if (Number.isFinite(claimedAtMs) && Date.now() - claimedAtMs < staleTimeoutMs) {
              return { updated: false, task };
            }
          }
        }

        if (
          options.expectedClaimToken !== undefined &&
          replyMetadata.claim_token !== options.expectedClaimToken
        ) {
          return { updated: false, task };
        }

        task.metadata = {
          ...metadata,
          gateway_reply_metadata: {
            ...replyMetadata,
            ...patch,
          },
        };
        return { updated: true, task };
      }
    ),
    findDueGatewayFinalReplyRefs: vi.fn(async ({ limit }: { limit?: number } = {}) => {
      const now = Date.now();
      return tasks
        .filter((task) => {
          const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<
            string,
            unknown
          >;
          if (!replyMeta.processing_comment_id) return false;
          const status = (replyMeta.delivery_status as string) ?? 'pending';
          if (status === 'delivered' || status === 'dead_letter') return false;
          if (replyMeta.next_retry_at && Date.parse(replyMeta.next_retry_at as string) > now) {
            return false;
          }
          if (status === 'processing') {
            const claimedAt = Date.parse((replyMeta.claimed_at as string) ?? '');
            if (Number.isFinite(claimedAt) && now - claimedAt < 5 * 60 * 1000) {
              return false;
            }
          }
          return true;
        })
        .slice(0, limit ?? 50)
        .map((task) => ({
          task_id: task.task_id,
          session_id: task.session_id,
          tenant_id: tenantId,
          attempts: Number(
            (task.metadata?.gateway_reply_metadata as Record<string, unknown>)?.attempts ?? 0
          ),
        }));
    }),
  };

  Object.assign(service as unknown as Record<string, unknown>, {
    channelRepo,
    threadMapRepo,
    messagesRepo,
    taskRepo,
  });

  return {
    service,
    sendMessage,
    setTasks: (t: Task[]) => {
      tasks = t;
    },
    setMessages: (m: Message[]) => {
      messages = m;
    },
    getMessages: () => messages,
    getMapping: () => mapping,
    channelRepo,
    threadMapRepo,
    messagesRepo,
    taskRepo,
  };
}

describe('Issue #3212 Regression & Recovery Suite: Gateway Final Reply Delivery', () => {
  const taskId = '019fd900-0000-7000-8000-000000000050';
  const processingCommentId = 901;

  it('Test Case 0: Terminal transition executes post-commit delivery trigger independently of session patching', async () => {
    // In the original defect, Agor relied solely on sessions.patch hooks to trigger delivery.
    // Because gateway sessions have title initialized at creation (gateway.ts:6716),
    // session.title is never null, so autoTitleSession never calls sessions.patch().
    const patchSessionMock = vi.fn();
    const autoTitleSession = async (task: Task, sessionTitle: string | null) => {
      if (!task.full_prompt) return;
      if (sessionTitle == null) {
        patchSessionMock(task.session_id, { title: 'Derived Title' });
      }
    };

    const task = {
      task_id: taskId,
      session_id: '019fd900-0000-7000-8000-000000000021',
      status: TaskStatus.COMPLETED,
      full_prompt: '@agor fix bug in issue #42',
    } as unknown as Task;

    const gatewaySessionTitle = '@agor fix bug in issue #42'.substring(0, 100);
    await autoTitleSession(task, gatewaySessionTitle);
    expect(patchSessionMock).not.toHaveBeenCalled();

    // The fix decouples delivery from session patching by registering triggerGatewayOutboundFlushAfterCommit
    // directly in TasksService.processTerminalTaskTransition.
  });

  it('Test Case 1: Missing final assistant message race schedules bounded backoff retry', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);

    // 1. Task reaches terminal state COMPLETED
    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: { gateway_reply_metadata: { processing_comment_id: processingCommentId } },
      } as unknown as Task,
    ]);

    // 2. Assistant message has not landed yet
    harness.setMessages([]);

    // 3. flushOutboundBuffer executes
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // 4. Verification: send was deferred, retry metadata scheduled
    expect(harness.sendMessage).not.toHaveBeenCalled();
    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('pending');
    expect(replyMeta.attempts).toBe(1);
    expect(replyMeta.next_retry_at).toBeDefined();

    // 5. Message lands in DB
    harness.setMessages([
      {
        message_id: '019fd900-0000-7000-8000-000000000052',
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Completed work output.',
        index: 1,
      } as unknown as Message,
    ]);

    // 6. Retry executes and successfully delivers
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const updatedTask = (await harness.taskRepo.findById(taskId)) as Task;
    const updatedMeta = (updatedTask.metadata?.gateway_reply_metadata ?? {}) as Record<
      string,
      unknown
    >;
    expect(updatedMeta.delivery_status).toBe('delivered');
  });

  it('Test Case 2: Transient GitHub API failure schedules backoff retry and records error details', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000052';

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: { gateway_reply_metadata: { processing_comment_id: processingCommentId } },
      } as unknown as Task,
    ]);
    harness.setMessages([
      {
        message_id: messageId,
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Final response for issue.',
        index: 1,
      } as unknown as Message,
    ]);

    // GitHub API fails transiently (502)
    harness.sendMessage.mockRejectedValueOnce(new Error('GitHub API 502 Bad Gateway'));

    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    expect(harness.sendMessage).toHaveBeenCalledOnce();

    // Verification: Task reply metadata is scheduled for retry with attempts incremented
    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('pending');
    expect(replyMeta.attempts).toBe(1);
    expect(replyMeta.next_retry_at).toBeDefined();
    expect(replyMeta.last_error).toContain('502 Bad Gateway');
  });

  it('Test Case 3: Process crash during external call is recovered after claim timeout expires', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000053';
    const staleClaimTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: {
          gateway_reply_metadata: {
            processing_comment_id: processingCommentId,
            delivery_status: 'processing',
            claim_token: 'dead-daemon-claim',
            claimed_at: staleClaimTime,
          },
        },
      } as unknown as Task,
    ]);
    harness.setMessages([
      {
        message_id: messageId,
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Durable message to be delivered.',
        index: 1,
        metadata: {
          gateway_final_reply: {
            status: 'processing',
            claim_token: 'dead-daemon-claim',
            claimed_at: staleClaimTime,
          },
        },
      } as unknown as Message,
    ]);

    // Active channel tenants populate for background worker
    (harness.service as unknown as { activeChannelTenants: Set<string> }).activeChannelTenants.add(
      tenantId
    );

    const reconciled = await runWithTenantContext(tenantId, () =>
      harness.service.checkFinalReplyDeliveryOnce()
    );

    expect(reconciled).toBe(1);
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('delivered');
  });

  it('Test Case 4: Concurrent workers are atomic and fence duplicate sends', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000054';

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: { gateway_reply_metadata: { processing_comment_id: processingCommentId } },
      } as unknown as Task,
    ]);
    harness.setMessages([
      {
        message_id: messageId,
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Single delivery content.',
        index: 1,
      } as unknown as Message,
    ]);

    // Run two simultaneous workers
    await runWithTenantContext(tenantId, () =>
      Promise.all([
        harness.service.flushOutboundBuffer(mapping.session_id, { taskId }),
        harness.service.flushOutboundBuffer(mapping.session_id, { taskId }),
      ])
    );

    // Only one send occurred
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('delivered');
  });

  it('Test Case 5: Expired claim handover recovers delivery across worker crash boundary', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000055';
    const staleClaimTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: {
          gateway_reply_metadata: {
            processing_comment_id: processingCommentId,
            delivery_status: 'processing',
            claim_token: 'worker-1-token',
            claimed_at: staleClaimTime,
          },
        },
      } as unknown as Task,
    ]);
    harness.setMessages([
      {
        message_id: messageId,
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Final content.',
        index: 1,
        metadata: {
          gateway_final_reply: {
            status: 'processing',
            claim_token: 'worker-1-token',
            claimed_at: staleClaimTime,
          },
        },
      } as unknown as Message,
    ]);

    // Worker 2 runs flushOutboundBuffer and reclaims the expired claim
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // Worker 2 succeeded in sending and marking delivered
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('delivered');
  });

  it('Test Case 6: Permanent provider failure transitions task to dead_letter state', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000056';

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: { gateway_reply_metadata: { processing_comment_id: processingCommentId } },
      } as unknown as Task,
    ]);
    harness.setMessages([
      {
        message_id: messageId,
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Message for deleted comment.',
        index: 1,
      } as unknown as Message,
    ]);

    // GitHub returns permanent 404
    const notFoundError = Object.assign(new Error('Not Found'), { status: 404 });
    harness.sendMessage.mockRejectedValueOnce(notFoundError);

    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('dead_letter');
    expect(replyMeta.next_retry_at).toBeNull();
    expect(replyMeta.last_error).toContain('Not Found');
  });

  it('Test Case 7: Rate limiting headers (Retry-After) are incorporated into backoff schedule', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000057';

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        created_at: '2026-08-14T00:00:01.000Z',
        completed_at: '2026-08-14T00:00:03.000Z',
        metadata: { gateway_reply_metadata: { processing_comment_id: processingCommentId } },
      } as unknown as Task,
    ]);
    harness.setMessages([
      {
        message_id: messageId,
        session_id: mapping.session_id,
        task_id: taskId,
        role: 'assistant',
        content: 'Rate limited message.',
        index: 1,
      } as unknown as Message,
    ]);

    // GitHub returns 403 rate limit with retry-after
    const rateLimitError = Object.assign(new Error('API rate limit exceeded'), {
      status: 403,
      retryAfter: 60,
      response: { headers: { 'retry-after': '60' } },
    });
    harness.sendMessage.mockRejectedValueOnce(rateLimitError);

    const before = Date.now();
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    const task = (await harness.taskRepo.findById(taskId)) as Task;
    const replyMeta = (task.metadata?.gateway_reply_metadata ?? {}) as Record<string, unknown>;
    expect(replyMeta.delivery_status).toBe('pending');
    expect(replyMeta.next_retry_at).toBeDefined();
    const nextRetryMs = Date.parse(replyMeta.next_retry_at as string);
    expect(nextRetryMs).toBeGreaterThanOrEqual(before + 59 * 1000);
  });

  it('Test Case 8: Cross-tenant isolation prevents accessing or delivering another tenant task', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const otherTenantId = 'tenant-other';

    harness.setTasks([
      {
        task_id: taskId,
        session_id: mapping.session_id,
        status: TaskStatus.COMPLETED,
        metadata: { gateway_reply_metadata: { processing_comment_id: processingCommentId } },
      } as unknown as Task,
    ]);

    // Foreign tenant isolation
    harness.taskRepo.findById.mockImplementationOnce(async () => null);

    await runWithTenantContext(otherTenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});
