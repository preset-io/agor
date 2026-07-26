import { beforeEach, describe, expect, it, vi } from 'vitest';
import { executeOpenCodeTask } from './opencode.js';

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  messagesCreate: vi.fn(),
  branchFind: vi.fn(),
  messagesFindBySession: vi.fn(),
  toolDeps: undefined as unknown,
  permissionServiceCtor: vi.fn(),
  permissionRegister: vi.fn(),
  permissionUnregister: vi.fn(),
}));

vi.mock('../../sdk-handlers/opencode/index.js', () => ({
  OpenCodePermissionRejectedError: class extends Error {},
  OpenCodeTool: class {
    constructor(deps: unknown) {
      mocks.toolDeps = deps;
    }
    runTurn = mocks.runTurn;
  },
}));

vi.mock('../../permissions/permission-service.js', () => ({
  PermissionService: class {
    constructor(emitEvent: unknown, timeoutMs: number) {
      mocks.permissionServiceCtor(emitEvent, timeoutMs);
    }
    cancelPendingRequests = vi.fn();
  },
}));

vi.mock('../../permissions/permission-manager.js', () => ({
  globalPermissionManager: {
    register: mocks.permissionRegister,
    unregister: mocks.permissionUnregister,
  },
}));

vi.mock('../../db/feathers-repositories.js', () => ({
  createFeathersBackedRepositories: () => ({
    messages: { findBySessionId: mocks.messagesFindBySession },
    messagesService: { create: mocks.messagesCreate },
    tasksService: {},
    sessionsService: {},
    branches: { findById: mocks.branchFind },
    sessionMCP: {},
    mcpServers: {},
    mcpOAuthAuthHeaders: {},
  }),
}));

vi.mock('./base-executor.js', () => ({
  createStreamingCallbacks: () => ({
    onStreamStart: vi.fn(),
    onStreamChunk: vi.fn(),
    onStreamEnd: vi.fn(),
  }),
}));

function createClient(order: string[]) {
  const services = {
    sessions: {
      get: vi.fn().mockResolvedValue({
        session_id: '00000000-0000-7000-8000-000000000001',
        branch_id: '00000000-0000-7000-8000-000000000003',
        title: 'OpenCode session',
        mcp_token: 'mcp-token',
        model_config: { provider: 'openai', model: 'gpt-test' },
      }),
      patch: vi.fn(async () => {
        order.push('persist');
        return {};
      }),
    },
    messages: { find: vi.fn().mockResolvedValue([]) },
    tasks: { patch: vi.fn().mockResolvedValue({}) },
  };

  return {
    services,
    client: {
      service(name: keyof typeof services) {
        return services[name];
      },
    },
  };
}

describe('executeOpenCodeTask', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.branchFind.mockResolvedValue({ path: '/worktree' });
    mocks.messagesCreate.mockResolvedValue({});
    mocks.messagesFindBySession.mockResolvedValue([{}, {}]);
  });

  it('uses runTurn as the single module boundary and persists a new provider session on request', async () => {
    const order: string[] = [];
    const { client, services } = createClient(order);
    mocks.runTurn.mockImplementation(async (turnInput) => {
      order.push('runTurn');
      await turnInput.persistOpenCodeSessionId('oc-created');
      order.push('prompt');
      return {
        openCodeSessionId: 'oc-created',
        sessionWasCreated: true,
        finalMessage: {
          content: 'before tool\nafter tool',
          contentBlocks: [
            { type: 'text', text: 'before tool' },
            { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } },
            { type: 'tool_result', tool_use_id: 'call-1', content: '/worktree' },
            { type: 'text', text: 'after tool' },
          ],
          toolUses: [{ id: 'call-1', name: 'bash', input: { command: 'pwd' } }],
          metadata: { opencode: { messageIds: ['assistant-1', 'assistant-2'] } },
        },
      };
    });

    const abortController = new AbortController();
    await executeOpenCodeTask({
      client: client as never,
      sessionId: '00000000-0000-7000-8000-000000000001' as never,
      taskId: '00000000-0000-7000-8000-000000000002' as never,
      prompt: 'Do the work',
      permissionMode: 'default',
      abortController,
      messageSource: 'gateway',
      dataHome: '/opaque/opencode-home',
      resolvedConfig: { execution: { permission_timeout_ms: 1234 } },
    });

    expect(mocks.runTurn).toHaveBeenCalledTimes(1);
    expect(mocks.runTurn.mock.calls[0][0]).toMatchObject({
      agorSessionId: '00000000-0000-7000-8000-000000000001',
      taskId: '00000000-0000-7000-8000-000000000002',
      prompt: 'Do the work',
      title: 'OpenCode session',
      directory: '/worktree',
      provider: 'openai',
      model: 'gpt-test',
      mcpToken: 'mcp-token',
      permissionMode: 'default',
      signal: abortController.signal,
      dataHome: '/opaque/opencode-home',
    });
    expect(mocks.permissionServiceCtor).toHaveBeenCalledWith(expect.any(Function), 1234);
    expect(mocks.permissionRegister).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000001',
      expect.anything()
    );
    expect(mocks.toolDeps).toMatchObject({
      permissionService: expect.anything(),
      messagesRepo: expect.anything(),
      messagesService: expect.anything(),
      tasksService: expect.anything(),
      sessionsService: expect.anything(),
    });
    expect(mocks.permissionUnregister).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000001');
    expect(order).toEqual(['runTurn', 'persist', 'prompt']);
    expect(services.sessions.patch).toHaveBeenCalledWith('00000000-0000-7000-8000-000000000001', {
      sdk_session_id: 'oc-created',
    });
    const assistantMessageId = mocks.runTurn.mock.calls[0][0].agorAssistantMessageId;
    expect(mocks.messagesCreate).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        role: 'user',
        task_id: '00000000-0000-7000-8000-000000000002',
        content: 'Do the work',
        metadata: { source: 'gateway' },
      })
    );
    expect(mocks.messagesCreate).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        message_id: assistantMessageId,
        role: 'assistant',
        index: 2,
        content_preview: 'before tool\nafter tool',
        content: [
          { type: 'text', text: 'before tool' },
          { type: 'tool_use', id: 'call-1', name: 'bash', input: { command: 'pwd' } },
          { type: 'tool_result', tool_use_id: 'call-1', content: '/worktree' },
          { type: 'text', text: 'after tool' },
        ],
        tool_uses: [{ id: 'call-1', name: 'bash', input: { command: 'pwd' } }],
      })
    );
    expect(services.tasks.patch).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000002',
      expect.objectContaining({ status: 'completed', model: 'openai/gpt-test' })
    );
  });

  it('reuses a daemon-written user message beyond the default Feathers page', async () => {
    const order: string[] = [];
    const { client } = createClient(order);
    const firstPage = Array.from({ length: 10000 }, (_, index) => ({
      message_id: `00000000-0000-7000-8000-${String(index).padStart(12, '0')}`,
      session_id: '00000000-0000-7000-8000-000000000001',
      task_id: `00000000-0000-7000-8001-${String(index).padStart(12, '0')}`,
      type: 'system',
      role: index % 2 === 0 ? 'user' : 'assistant',
      index,
      timestamp: '2026-07-24T00:00:00.000Z',
      content_preview: `Previous message ${index}`,
      content: `Previous message ${index}`,
    }));
    const existingUserMessage = {
      message_id: '00000000-0000-7000-8000-000000000004',
      session_id: '00000000-0000-7000-8000-000000000001',
      task_id: '00000000-0000-7000-8000-000000000002',
      type: 'system',
      role: 'user',
      index: 10000,
      timestamp: '2026-07-24T00:00:00.000Z',
      content_preview: 'Daemon wrote this prompt',
      content: 'Daemon wrote this prompt',
      metadata: { is_agor_callback: true, source: 'agor' },
    };
    mocks.messagesFindBySession.mockResolvedValue([...firstPage, existingUserMessage]);
    mocks.runTurn.mockResolvedValue({
      openCodeSessionId: 'oc-existing',
      sessionWasCreated: false,
      finalMessage: {
        content: 'done',
        contentBlocks: [{ type: 'text', text: 'done' }],
        toolUses: [],
        metadata: {},
      },
    });

    await executeOpenCodeTask({
      client: client as never,
      sessionId: '00000000-0000-7000-8000-000000000001' as never,
      taskId: '00000000-0000-7000-8000-000000000002' as never,
      prompt: 'Daemon wrote this prompt',
      abortController: new AbortController(),
      messageSource: 'agor',
    });

    expect(mocks.messagesCreate).toHaveBeenCalledTimes(1);
    expect(mocks.messagesCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        role: 'assistant',
        index: 10001,
      })
    );
  });

  it('passes a stored provider session to runTurn for validation instead of replacing it', async () => {
    const order: string[] = [];
    const { client, services } = createClient(order);
    services.sessions.get.mockResolvedValueOnce({
      session_id: '00000000-0000-7000-8000-000000000001',
      branch_id: '00000000-0000-7000-8000-000000000003',
      title: 'Existing',
      sdk_session_id: 'oc-existing',
    } as never);
    mocks.runTurn.mockResolvedValue({
      openCodeSessionId: 'oc-existing',
      sessionWasCreated: false,
      finalMessage: {
        content: 'continued',
        contentBlocks: [{ type: 'text', text: 'continued' }],
        toolUses: [],
        metadata: {},
      },
    });

    await executeOpenCodeTask({
      client: client as never,
      sessionId: '00000000-0000-7000-8000-000000000001' as never,
      taskId: '00000000-0000-7000-8000-000000000002' as never,
      prompt: 'Continue',
      abortController: new AbortController(),
    });

    expect(mocks.runTurn.mock.calls[0][0].existingOpenCodeSessionId).toBe('oc-existing');
    expect(services.sessions.patch).not.toHaveBeenCalled();
  });

  it('settles a denied permission only after the managed turn has finished cleanup', async () => {
    const { OpenCodePermissionRejectedError } = await import(
      '../../sdk-handlers/opencode/index.js'
    );
    const order: string[] = [];
    const { client, services } = createClient([]);
    mocks.runTurn.mockImplementationOnce(async () => {
      order.push('managed cleanup settled');
      throw new OpenCodePermissionRejectedError('OpenCode permission was rejected');
    });
    services.tasks.patch.mockImplementationOnce(async (_taskId, task) => {
      order.push(`task ${task.status}`);
      return {};
    });

    await expect(
      executeOpenCodeTask({
        client: client as never,
        sessionId: '00000000-0000-7000-8000-000000000001' as never,
        taskId: '00000000-0000-7000-8000-000000000002' as never,
        prompt: 'Needs permission',
        abortController: new AbortController(),
      })
    ).rejects.toThrow('OpenCode permission was rejected');

    expect(services.tasks.patch).toHaveBeenCalledWith(
      '00000000-0000-7000-8000-000000000002',
      expect.objectContaining({ status: 'failed' })
    );
    expect(order).toEqual(['managed cleanup settled', 'task failed']);
  });
});
