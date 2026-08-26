import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  createUserMessage: vi.fn(),
  messagesCreate: vi.fn(),
  taskMessagesFind: vi.fn(),
  nextMessageIndex: vi.fn(),
  branchFind: vi.fn(),
  permissionRegister: vi.fn(),
  permissionUnregister: vi.fn(),
  openCodeConstructor: vi.fn(),
  getMcpServersForSession: vi.fn(),
  tasksGet: vi.fn(),
  sessionsGet: vi.fn(),
}));

vi.mock('@agor/core/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: mocks.getMcpServersForSession,
}));

vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  isOpenCodeCleanupUnverifiedError: (error: unknown) =>
    error instanceof Error && error.name === 'OpenCodeCleanupUnverifiedError',
  OpenCodeTool: class {
    constructor(options: unknown) {
      mocks.openCodeConstructor(options);
    }
    runTurn = mocks.runTurn;
  },
}));

vi.mock('../../db/feathers-repositories.js', () => ({
  createFeathersBackedRepositories: () => ({
    branches: { findById: mocks.branchFind },
    messages: {
      findInitialUserMessagesByTaskId: mocks.taskMessagesFind,
      getNextIndexBySessionId: mocks.nextMessageIndex,
    },
    messagesService: { create: mocks.messagesCreate },
    sessionMCP: {},
    mcpServers: {},
    mcpOAuthAuthHeaders: {},
    tasksService: { get: mocks.tasksGet },
    sessionsService: { get: mocks.sessionsGet },
  }),
}));

vi.mock('../../permissions/permission-service.js', () => ({
  PermissionService: class {},
}));

vi.mock('../../permissions/permission-manager.js', () => ({
  globalPermissionManager: {
    register: mocks.permissionRegister,
    unregister: mocks.permissionUnregister,
  },
}));

vi.mock('../../sdk-handlers/claude/message-builder.js', () => ({
  createUserMessage: mocks.createUserMessage,
}));

vi.mock('./base-executor.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./base-executor.js')>()),
  createStreamingCallbacks: () => ({}),
}));

import { executeOpenCodeTask } from './opencode.js';

const sessionId = '00000000-0000-7000-8000-000000000001';
const taskId = '00000000-0000-7000-8000-000000000002';

function client(sessionOverrides: Record<string, unknown> = {}) {
  const services = {
    sessions: {
      get: vi.fn(async () => ({
        session_id: sessionId,
        branch_id: '00000000-0000-7000-8000-000000000003',
        title: 'OpenCode session',
        model_config: { mode: 'exact', provider: 'openai', model: 'gpt-test' },
        ...sessionOverrides,
      })),
      patch: vi.fn(async () => ({})),
      emit: vi.fn(),
    },
    tasks: { patch: vi.fn(async () => ({})) },
    messages: {
      find: vi.fn(async () => ({ total: 0, limit: 1, skip: 0, data: [] })),
      create: vi.fn(async () => ({})),
    },
  };
  return {
    services,
    value: { service: (name: keyof typeof services) => services[name] },
  };
}

function execute(
  value: ReturnType<typeof client>['value'],
  abortController = new AbortController()
) {
  return executeOpenCodeTask({
    client: value as never,
    sessionId: sessionId as never,
    taskId: taskId as never,
    prompt: 'Continue',
    abortController,
    agenticToolContext: { dataHome: '/opaque/opencode-home' },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.branchFind.mockResolvedValue({ path: '/worktree' });
  mocks.taskMessagesFind.mockResolvedValue([]);
  mocks.nextMessageIndex.mockResolvedValueOnce(0).mockResolvedValueOnce(1);
  mocks.runTurn.mockResolvedValue({
    finalMessage: {
      content: 'done',
      contentBlocks: [{ type: 'text', text: 'done' }],
      toolUses: [],
      metadata: {},
    },
  });
  mocks.getMcpServersForSession.mockResolvedValue([]);
  mocks.tasksGet.mockResolvedValue({ created_by: 'task-creator' });
  mocks.sessionsGet.mockResolvedValue({ created_by: 'session-owner' });
});

describe('OpenCode executor adapter', () => {
  it('preserves the exact provider/model and native session across resume', async () => {
    const state = client({
      sdk_session_id: 'oc-existing',
      model_config: {
        mode: 'exact',
        provider: 'openai',
        model: 'gpt-test',
        effort: 'max',
      },
    });

    await execute(state.value);

    expect(mocks.runTurn).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-test',
        effort: 'max',
        existingOpenCodeSessionId: 'oc-existing',
        dataHome: '/opaque/opencode-home',
      }),
      expect.anything()
    );
    expect(state.services.sessions.patch).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'completed', model: 'openai/gpt-test' })
    );
  });

  it('hydrates and filters MCP definitions for the task creator', async () => {
    const state = client({ created_by: 'session-owner' });

    await execute(state.value);
    const options = mocks.openCodeConstructor.mock.calls[0][0] as {
      resolveMcpServers(sessionId: string): Promise<unknown>;
    };
    await options.resolveMcpServers(sessionId);

    expect(mocks.getMcpServersForSession).toHaveBeenCalledWith(
      sessionId,
      expect.objectContaining({
        forUserId: 'task-creator',
      }),
      { toolFiltering: 'intercept' }
    );
  });

  it('persists a newly-created native session before completing the task', async () => {
    const order: string[] = [];
    const state = client();
    state.services.sessions.patch.mockImplementation(async () => {
      order.push('session');
      return {};
    });
    state.services.tasks.patch.mockImplementation(async () => {
      order.push('task');
      return {};
    });
    mocks.runTurn.mockImplementation(async (input) => {
      await input.persistOpenCodeSessionId('oc-created');
      order.push('turn-clean');
      return {
        finalMessage: {
          content: 'done',
          contentBlocks: [{ type: 'text', text: 'done' }],
          toolUses: [],
          metadata: {},
        },
      };
    });

    await execute(state.value);

    expect(state.services.sessions.patch).toHaveBeenCalledWith(sessionId, {
      sdk_session_id: 'oc-created',
    });
    expect(order).toEqual(['session', 'turn-clean', 'task']);
  });

  it('surfaces a provider failure in the task and transcript', async () => {
    const order: string[] = [];
    const state = client();
    state.services.messages.create.mockImplementation(async () => {
      order.push('message');
      return {};
    });
    state.services.tasks.patch.mockImplementation(async () => {
      order.push('task');
      return {};
    });
    mocks.runTurn.mockRejectedValue(new Error('OpenCode provider authentication failed'));

    await expect(execute(state.value)).rejects.toThrow('OpenCode provider authentication failed');

    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({
        status: 'failed',
        error_message: 'OpenCode provider authentication failed',
      })
    );
    expect(state.services.messages.create).toHaveBeenCalledWith(
      expect.objectContaining({
        session_id: sessionId,
        task_id: taskId,
        type: 'system',
        role: 'system',
        content: 'OpenCode provider authentication failed',
        metadata: { is_task_failure: true },
      })
    );
    expect(order).toEqual(['message', 'task']);
  });

  it('rejects a missing exact pair before provider side effects', async () => {
    const state = client({ model_config: { mode: 'exact', provider: 'openai', model: '' } });

    await expect(execute(state.value)).rejects.toThrow(/provider and model/i);

    expect(mocks.branchFind).not.toHaveBeenCalled();
    expect(mocks.createUserMessage).not.toHaveBeenCalled();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('leaves cleanup-unverified work active for daemon containment', async () => {
    const state = client();
    const failure = new Error('private runtime detail');
    failure.name = 'OpenCodeCleanupUnverifiedError';
    mocks.runTurn.mockRejectedValue(failure);

    await expect(execute(state.value)).resolves.toBeUndefined();

    expect(state.services.tasks.patch).not.toHaveBeenCalled();
    expect(state.services.messages.create).not.toHaveBeenCalled();
    expect(mocks.permissionUnregister).toHaveBeenCalledWith(sessionId);
  });

  it('does not make an aborted turn terminal', async () => {
    const state = client();
    const abortController = new AbortController();
    abortController.abort();
    mocks.runTurn.mockRejectedValue(new Error('cancelled'));

    await expect(execute(state.value, abortController)).rejects.toThrow('cancelled');

    expect(state.services.tasks.patch).not.toHaveBeenCalled();
    expect(state.services.messages.create).not.toHaveBeenCalled();
  });
});
