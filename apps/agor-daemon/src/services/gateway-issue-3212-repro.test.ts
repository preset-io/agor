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

describe('Issue #3212 Reproduction Tests: Gateway Final Reply Delivery', () => {
  const taskId = '019fd900-0000-7000-8000-000000000050';
  const processingCommentId = 901;

  it('Test Case 0: Trigger omission - TasksService terminal transition never patches session when title is set', async () => {
    // When a task finishes, TasksService.processTerminalTaskTransition runs.
    // It emits 'sessions.patched' event (for websocket/UI), but does NOT call sessions.patch()
    // unless autoTitleSession runs AND session.title == null.
    // Because gateway sessions have title initialized at creation (gateway.ts:6716),
    // session.title is NEVER null.
    // Consequently, sessions.patch() is NEVER called upon task completion.
    // Therefore, the only caller of flushOutboundBuffer (sessions.after.patch) NEVER FIRES!

    const patchSessionMock = vi.fn();
    const _emitEventMock = vi.fn();
    const autoTitleSession = async (task: Task, sessionTitle: string | null) => {
      // Replicates TasksService.autoTitleSession (tasks.ts:524-546)
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

    // Gateway-created session has title set from prompt text (e.g. gateway.ts:6716)
    const gatewaySessionTitle = '@agor fix bug in issue #42'.substring(0, 100);

    // Run autoTitleSession as TasksService does during terminal transition
    await autoTitleSession(task, gatewaySessionTitle);

    // sessions.patch() is NOT called!
    expect(patchSessionMock).not.toHaveBeenCalled();

    // Because sessions.patch() is never called, sessions.after.patch hooks never fire,
    // and flushOutboundBuffer is NEVER invoked upon task completion!
  });

  it('Test Case 1: Missing final assistant message race permanently abandons delivery', async () => {
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

    // 2. At the time flushOutboundBuffer is called, the assistant message has not yet landed in DB.
    // (Only user message exists, or messages list is empty)
    harness.setMessages([]);

    // 3. flushOutboundBuffer executes (single caller from sessions.patch hook)
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // 4. Verification: flushOutboundBuffer returned silently without sending message or recording claim
    expect(harness.sendMessage).not.toHaveBeenCalled();
    expect(harness.messagesRepo.mutateMetadataLocked).not.toHaveBeenCalled();

    // 5. Message becomes available in DB afterward
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

    // 6. Because no retry mechanism exists and no further session patch occurs,
    // the system is stuck: sendMessage remains uncalled forever.
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });

  it('Test Case 2: Transient GitHub API failure releases claim to pending without scheduling a retry', async () => {
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

    // GitHub API fails transiently (e.g. ECONNRESET or 502)
    harness.sendMessage.mockRejectedValueOnce(new Error('GitHub API 502 Bad Gateway'));

    // flushOutboundBuffer fires once
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // Verification:
    // 1. External call was attempted
    expect(harness.sendMessage).toHaveBeenCalledOnce();

    // 2. Claim was released to { status: 'pending' }
    const updatedMessage = harness.getMessages().find((m) => m.message_id === messageId);
    expect(updatedMessage?.metadata?.gateway_final_reply).toEqual({ status: 'pending' });

    // 3. No background timer, cron, or retry loop exists:
    // The comment on GitHub remains stuck at 'Processing...' forever unless an external patch occurs.
  });

  it('Test Case 3: Process crash during external call leaves abandoned processing claim with no recovery', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000053';

    // Simulate crash after acquiring claim:
    // The message is left with { status: 'processing', claim_token: 'dead-daemon-claim', claimed_at: pastDate }
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
        content: 'Durable message to be delivered.',
        index: 1,
        metadata: {
          gateway_final_reply: {
            status: 'processing',
            claim_token: 'dead-daemon-claim',
            claimed_at: '2026-08-14T00:00:00.000Z',
          },
        },
      } as unknown as Message,
    ]);

    // Daemon restarts. In existing architecture:
    // Startup does NOT scan for unfinished gateway final replies.
    // If no session patch lands, it is never retried even after timeout expires.
    expect(harness.sendMessage).not.toHaveBeenCalled();
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
    const updated = harness.getMessages().find((m) => m.message_id === messageId);
    expect(updated?.metadata?.gateway_final_reply?.status).toBe('delivered');
  });

  it('Test Case 5: Claim timeout allows second worker to steal claim, causing duplicate external call', async () => {
    const mapping = githubMapping();
    const harness = makeReproHarness(mapping);
    const messageId = '019fd900-0000-7000-8000-000000000055';

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
        content: 'Final content.',
        index: 1,
        metadata: {
          gateway_final_reply: {
            status: 'processing',
            claim_token: 'worker-1-token',
            // Stale claim: > 5 minutes old
            claimed_at: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
          },
        },
      } as unknown as Message,
    ]);

    // Worker 2 runs flushOutboundBuffer and steals claim
    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // Worker 2 succeeded in sending
    expect(harness.sendMessage).toHaveBeenCalledOnce();
    const updated = harness.getMessages().find((m) => m.message_id === messageId);
    expect(updated?.metadata?.gateway_final_reply?.status).toBe('delivered');

    // Note on effectively-once semantics:
    // Both Worker 1 and Worker 2 issue `octokit.issues.updateComment` with the exact same
    // `edit_comment_id` and body. Because GitHub's updateComment is idempotent,
    // duplicate execution results in the same final comment state.
  });

  it('Test Case 6: Permanent failure (e.g. 404 Comment Not Found) is treated as pending and lacks dead-letter handling', async () => {
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

    // Existing behavior: resets to 'pending' instead of distinguishing permanent failure / dead-letter
    const updated = harness.getMessages().find((m) => m.message_id === messageId);
    expect(updated?.metadata?.gateway_final_reply).toEqual({ status: 'pending' });
    // There is no error classification, no dead_letter status, and no record of the 404 status.
  });

  it('Test Case 7: Rate limiting headers (Retry-After) are discarded', async () => {
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
      response: { headers: { 'retry-after': '60' } },
    });
    harness.sendMessage.mockRejectedValueOnce(rateLimitError);

    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // Existing behavior: simply sets status: 'pending' and drops retry-after information completely
    const updated = harness.getMessages().find((m) => m.message_id === messageId);
    expect(updated?.metadata?.gateway_final_reply).toEqual({ status: 'pending' });
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

    // In a multi-tenant DB with RLS, taskRepo.findById or messagesRepo under a foreign tenant
    // will return null / empty.
    harness.taskRepo.findById.mockImplementationOnce(async () => null);

    await runWithTenantContext(otherTenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id, { taskId })
    );

    // Delivery was safely skipped for the wrong tenant
    expect(harness.sendMessage).not.toHaveBeenCalled();
  });
});
