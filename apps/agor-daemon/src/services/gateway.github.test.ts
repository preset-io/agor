import { materializeAgenticToolConfiguration } from '@agor/agentic-tools/config';
import { getBaseUrl } from '@agor/core/config';
import type { TenantScopeAwareDatabase } from '@agor/core/db';
import {
  getCurrentTenantDatabaseScope,
  getCurrentTenantId,
  runWithTenantContext,
  runWithTenantDatabaseScope,
} from '@agor/core/db';
import { getConnector } from '@agor/core/gateway';
import type { GatewayChannel, Message, ThreadSessionMap, User, UserID } from '@agor/core/types';
import { SessionStatus } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
    getBaseUrl: vi.fn(async () => 'https://agor.example.com'),
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
  created_at: '2026-08-14T00:00:00.000Z',
  updated_at: '2026-08-14T00:00:00.000Z',
  last_login_at: null,
  avatar_url: null,
  default_agentic_config: {},
  unix_username: null,
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
  agentic_config: null,
  created_by: '019fd900-0000-7000-8000-000000000014',
  created_at: '2026-08-14T00:00:00.000Z',
  updated_at: '2026-08-14T00:00:00.000Z',
  last_message_at: null,
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

function makeGitHubHarness(existingMapping: ThreadSessionMap | null = null) {
  let mapping = existingMapping;
  let messages: Message[] = [];
  let taskMetadata: Record<string, unknown> | undefined;
  const order: string[] = [];
  const db = { run: vi.fn() } as unknown as TenantScopeAwareDatabase;
  const usersGet = vi.fn(async (id: string) => {
    expect(id).toBe(alignedUser.user_id);
    return alignedUser;
  });
  const sessionsCreate = vi.fn(async (data: Record<string, unknown>) => ({
    ...data,
    session_id: data.session_id,
    status: SessionStatus.IDLE,
  }));
  const sessionsGet = vi.fn(async (sessionId: string) => ({
    session_id: sessionId,
    branch_id: githubChannel.target_branch_id,
    created_by: alignedUser.user_id,
    status: SessionStatus.IDLE,
    custom_context: { gateway_source: { channel_id: githubChannel.id } },
  }));
  const promptCreate = vi.fn(async (data: Record<string, unknown>, params: unknown) => {
    order.push('prompt');
    return {
      task_id: data.idempotencyTaskId,
      session_id: (params as { route: { id: string } }).route.id,
      status: 'running',
    };
  });
  const app = {
    service: (name: string) => {
      if (name === 'users') return { get: usersGet };
      if (name === 'sessions') {
        return {
          create: sessionsCreate,
          get: sessionsGet,
          patch: vi.fn(async () => undefined),
          setMCPServers: vi.fn(async () => undefined),
        };
      }
      if (name === '/sessions/:id/prompt') return { create: promptCreate };
      throw new Error(`Unexpected service: ${name}`);
    },
  };
  const sendMessage = vi.fn(async () => 'provider-message-id');
  vi.mocked(getConnector).mockReturnValue({ sendMessage } as never);

  const service = new GatewayService(db, app as never);
  Object.assign(service as unknown as Record<string, unknown>, {
    durableListenerOwnership: true,
  });
  const create = service.create.bind(service);
  service.create = (data) => {
    if (getCurrentTenantDatabaseScope()) return create(data);
    return runWithTenantDatabaseScope(db, tenantId, () => create(data));
  };

  const channelRepo = {
    findByKey: vi.fn(async () => githubChannel),
    findById: vi.fn(async () => githubChannel),
    listenerClaimIsCurrent: vi.fn(async () => true),
    updateLastMessage: vi.fn(async () => undefined),
  };
  const threadMapRepo = {
    findByChannelAndThread: vi.fn(async () => mapping),
    findByThread: vi.fn(async () => null),
    findBySession: vi.fn(async () => mapping),
    findById: vi.fn(async () => mapping),
    updateLastMessage: vi.fn(async () => undefined),
    updateMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) mapping = { ...mapping, metadata } as ThreadSessionMap;
    }),
    mergeMetadata: vi.fn(async (_id: string, metadata: Record<string, unknown>) => {
      if (mapping) {
        mapping = {
          ...mapping,
          metadata: { ...((mapping.metadata as Record<string, unknown>) ?? {}), ...metadata },
        } as ThreadSessionMap;
      }
    }),
    completeSeedInitialPrompt: vi.fn(async () => mapping),
    create: vi.fn(async (data: Partial<ThreadSessionMap>) => {
      mapping = githubMapping({
        ...data,
        id: '019fd900-0000-7000-8000-000000000022',
        metadata: data.metadata ?? null,
      });
      return mapping;
    }),
  };
  const findByEmailForAlignment = vi.fn(async () => alignedUser);
  const messagesRepo = { findBySessionId: vi.fn(async () => messages) };
  const inboundEventRepo = {
    claim: vi.fn(async () => {
      order.push('claim');
      return {
        outcome: 'claimed',
        event: {
          id: '019fd900-0000-7000-8000-000000000030',
          delivery_metadata: null,
        },
      };
    }),
    recordDeliveryMetadata: vi.fn(async () => {
      order.push('record-delivery');
      return true;
    }),
    complete: vi.fn(async () => {
      order.push('complete');
      return true;
    }),
  };
  Object.assign(service as unknown as Record<string, unknown>, {
    channelRepo,
    threadMapRepo,
    usersRepo: { findByEmailForAlignment },
    outboundRepo: { findUnconsumedByChannelAndThread: vi.fn(async () => null) },
    inboundEventRepo,
    messagesRepo,
    taskRepo: {
      findById: vi.fn(async () => (taskMetadata ? { metadata: taskMetadata } : null)),
    },
    sessionRepo: {
      findById: vi.fn(async (sessionId: string) => ({
        session_id: sessionId,
        branch_id: githubChannel.target_branch_id,
        created_by: alignedUser.user_id,
        status: SessionStatus.IDLE,
        custom_context: { gateway_source: { channel_id: githubChannel.id } },
      })),
    },
  });

  return {
    service,
    order,
    sendMessage,
    usersGet,
    sessionsCreate,
    promptCreate,
    channelRepo,
    threadMapRepo,
    messagesRepo,
    findByEmailForAlignment,
    inboundEventRepo,
    getMapping: () => mapping,
    setMessages: (next: Message[]) => {
      messages = next;
    },
    setTaskMetadata: (next: Record<string, unknown>) => {
      taskMetadata = next;
    },
  };
}

function handleGitHubInbound(
  service: GatewayService,
  input: {
    providerEventId: string;
    text: string;
    prepareDelivery: () => Promise<Record<string, unknown>>;
  }
): Promise<void> {
  return (
    service as unknown as {
      handleListenerInboundMessage: (
        channel: GatewayChannel,
        tenant: string,
        message: Record<string, unknown>,
        lease: { claim_token: string }
      ) => Promise<void>;
    }
  ).handleListenerInboundMessage(
    githubChannel,
    tenantId,
    {
      ...input,
      threadId,
      userId: 'octocat',
      timestamp: '2026-08-14T00:00:00.000Z',
      metadata: githubMetadata,
    },
    { claim_token: 'listener-owner' }
  );
}

beforeEach(() => {
  vi.stubEnv('AGOR_MASTER_SECRET', 'gateway-test-master-secret');
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.mocked(materializeAgenticToolConfiguration).mockClear();
  vi.mocked(getBaseUrl).mockReset();
  vi.mocked(getBaseUrl).mockResolvedValue('https://agor.example.com');
  vi.mocked(getConnector).mockReset();
});

describe('GatewayService GitHub integration', () => {
  it('attributes, routes, and durably admits a new GitHub mention in its tenant', async () => {
    const harness = makeGitHubHarness();
    const prepareDelivery = vi.fn(async () => {
      expect(getCurrentTenantId()).toBe(tenantId);
      harness.order.push('prepare-delivery');
      return { processing_comment_id: 900 };
    });

    await handleGitHubInbound(harness.service, {
      providerEventId: 'github:preset-io/agor:comment:100',
      text: '@agor please investigate',
      prepareDelivery,
    });

    expect(harness.order).toEqual([
      'claim',
      'prepare-delivery',
      'record-delivery',
      'prompt',
      'complete',
    ]);
    expect(harness.findByEmailForAlignment).toHaveBeenCalledWith(alignedUser.email);
    expect(harness.usersGet).toHaveBeenCalledWith(alignedUser.user_id);
    expect(harness.sessionsCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: expect.any(String),
        branch_id: githubChannel.target_branch_id,
        created_by: alignedUser.user_id,
        custom_context: {
          gateway_source: expect.objectContaining({
            channel_id: githubChannel.id,
            channel_type: 'github',
            thread_id: threadId,
            github_repo: 'preset-io/agor',
            github_issue_number: 42,
            github_thread_id: threadId,
            last_message_only: true,
          }),
        },
      }),
      { _agenticConfigResolved: true }
    );

    const [promptData, promptParams] = harness.promptCreate.mock.calls[0];
    expect(promptData).toMatchObject({
      prompt: expect.stringContaining('[GitHub] @octocat mentioned you on preset-io/agor#42'),
      messageSource: 'gateway',
      idempotencyTaskId: expect.any(String),
      metadata: {
        gateway_inbound_event_id: '019fd900-0000-7000-8000-000000000030',
        gateway_reply_metadata: { processing_comment_id: 900 },
      },
    });
    expect(promptData.prompt).toContain('@agor please investigate');
    expect(promptParams).toMatchObject({
      route: { id: expect.any(String) },
      user: { user_id: alignedUser.user_id },
      tenant: { tenant_id: tenantId, source: 'explicit' },
    });
    expect(harness.getMapping()).toMatchObject({
      channel_id: githubChannel.id,
      thread_id: threadId,
      session_id: promptParams.route.id,
      branch_id: githubChannel.target_branch_id,
      metadata: expect.objectContaining({ processing_comment_id: 900 }),
    });
    expect(harness.sendMessage).toHaveBeenCalledWith({
      threadId,
      text: expect.stringContaining('Processing...'),
      metadata: { edit_comment_id: 900 },
    });
    expect(harness.inboundEventRepo.recordDeliveryMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: githubChannel.id,
        processingToken: 'listener-owner',
        metadata: { processing_comment_id: 900 },
      })
    );
    expect(harness.inboundEventRepo.complete).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: githubChannel.id,
        sessionId: promptParams.route.id,
        taskId: promptData.idempotencyTaskId,
      })
    );
  });

  it('keeps follow-ups on the mapped issue and edits the latest ack with only the final reply', async () => {
    const mapping = githubMapping();
    const harness = makeGitHubHarness(mapping);
    const prepareDelivery = vi.fn(async () => ({ processing_comment_id: 901 }));

    await handleGitHubInbound(harness.service, {
      providerEventId: 'github:preset-io/agor:comment:101',
      text: '@agor one more detail',
      prepareDelivery,
    });

    expect(harness.sessionsCreate).not.toHaveBeenCalled();
    expect(harness.threadMapRepo.updateMetadata).toHaveBeenCalledWith(
      mapping.id,
      expect.objectContaining({ processing_comment_id: 901 })
    );
    const [promptData, promptParams] = harness.promptCreate.mock.calls[0];
    expect(promptData).toMatchObject({
      prompt: expect.stringContaining('**Message via GitHub**'),
      metadata: {
        gateway_inbound_event_id: '019fd900-0000-7000-8000-000000000030',
        gateway_reply_metadata: { processing_comment_id: 901 },
      },
    });
    expect(promptData.prompt).toContain('Repo: preset-io/agor');
    expect(promptData.prompt).toContain('Issue/PR: #42');
    expect(promptData.prompt).toContain('@agor one more detail');
    expect(promptParams).toMatchObject({
      route: { id: mapping.session_id },
      user: { user_id: alignedUser.user_id },
      tenant: { tenant_id: tenantId, source: 'explicit' },
    });
    expect(harness.sendMessage).not.toHaveBeenCalled();

    await runWithTenantContext(tenantId, async () => {
      await harness.service.routeMessage({
        session_id: mapping.session_id,
        message: 'intermediate reasoning',
      });
      await harness.service.routeMessage({
        session_id: mapping.session_id,
        message: 'process-local final response',
      });
    });
    expect(harness.sendMessage).not.toHaveBeenCalled();

    harness.setMessages([
      {
        message_id: '019fd900-0000-7000-8000-000000000040',
        session_id: mapping.session_id,
        task_id: promptData.idempotencyTaskId,
        type: 'assistant',
        role: 'assistant',
        index: 2,
        timestamp: '2026-08-14T00:00:02.000Z',
        content_preview: 'durable final response',
        content: 'durable final response',
      } as Message,
    ]);
    harness.setTaskMetadata({
      gateway_reply_metadata: { processing_comment_id: 901 },
    });

    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer(mapping.session_id)
    );

    expect(harness.sendMessage).toHaveBeenCalledOnce();
    expect(harness.sendMessage).toHaveBeenCalledWith({
      threadId,
      text: 'durable final response',
      blocks: undefined,
      metadata: { edit_comment_id: 901 },
    });
    expect(harness.threadMapRepo.mergeMetadata).toHaveBeenCalledWith(mapping.id, {
      gateway_last_flushed_message_id: '019fd900-0000-7000-8000-000000000040',
    });
  });

  it('skips durable message reads when the session has no gateway mapping', async () => {
    const harness = makeGitHubHarness(null);

    await runWithTenantContext(tenantId, () =>
      harness.service.flushOutboundBuffer('019fd900-0000-7000-8000-000000000099')
    );

    expect(harness.threadMapRepo.findBySession).toHaveBeenCalledOnce();
    expect(harness.messagesRepo.findBySessionId).not.toHaveBeenCalled();
    expect(harness.channelRepo.findById).not.toHaveBeenCalled();
  });
});
