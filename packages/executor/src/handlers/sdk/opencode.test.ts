import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  runTurn: vi.fn(),
  createUserMessage: vi.fn(),
  messagesCreate: vi.fn(),
  messagesFind: vi.fn(),
  branchFind: vi.fn(),
  permissionRegister: vi.fn(),
  permissionUnregister: vi.fn(),
}));

vi.mock('@agor/agentic-tool-opencode/runtime', () => ({
  isOpenCodeCleanupUnverifiedError: (error: unknown) =>
    error instanceof Error && error.name === 'OpenCodeCleanupUnverifiedError',
  OpenCodeTool: class {
    runTurn = mocks.runTurn;
  },
}));

vi.mock('../../db/feathers-repositories.js', () => ({
  createFeathersBackedRepositories: () => ({
    branches: { findById: mocks.branchFind },
    messages: { findBySessionId: mocks.messagesFind },
    messagesService: { create: mocks.messagesCreate },
    sessionMCP: {},
    mcpServers: {},
    mcpOAuthAuthHeaders: {},
    tasksService: {},
    sessionsService: {},
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
      find: vi.fn(async () => ({ total: 0 })),
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
  mocks.messagesFind.mockResolvedValueOnce([]).mockResolvedValueOnce([{}]);
  mocks.runTurn.mockResolvedValue({
    finalMessage: {
      content: 'done',
      contentBlocks: [{ type: 'text', text: 'done' }],
      toolUses: [],
      metadata: {},
    },
  });
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

    await expect(execute(state.value)).resolves.toMatchObject({
      result: 'success',
      taskPatch: { model: 'openai/gpt-test' },
    });

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
    expect(state.services.tasks.patch).not.toHaveBeenCalled();
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
    expect(order).toEqual(['session', 'turn-clean']);
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

    await expect(execute(state.value)).resolves.toMatchObject({
      result: 'failure',
      failureCause: 'runtime_failure',
      taskPatch: { error_message: 'OpenCode provider authentication failed' },
      error: expect.objectContaining({ message: 'OpenCode provider authentication failed' }),
    });

    expect(state.services.tasks.patch).not.toHaveBeenCalled();
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
    expect(order).toEqual(['message']);
  });

  it('rejects a missing exact pair before provider side effects', async () => {
    const state = client({ model_config: { mode: 'exact', provider: 'openai', model: '' } });

    await expect(execute(state.value)).resolves.toMatchObject({
      result: 'failure',
      failureCause: 'runtime_failure',
      error: expect.objectContaining({ message: expect.stringMatching(/provider and model/i) }),
    });

    expect(mocks.branchFind).not.toHaveBeenCalled();
    expect(mocks.createUserMessage).not.toHaveBeenCalled();
    expect(mocks.runTurn).not.toHaveBeenCalled();
    expect(state.services.tasks.patch).not.toHaveBeenCalled();
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

    await expect(execute(state.value, abortController)).resolves.toEqual({ result: 'failure', failureCause: 'runtime_cancelled' });

    expect(state.services.tasks.patch).not.toHaveBeenCalled();
    expect(state.services.messages.create).not.toHaveBeenCalled();
  });
});
