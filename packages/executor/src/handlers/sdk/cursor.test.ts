import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import {
  buildCursorAssistantContent,
  executeCursorTask,
  normalizeCursorToolInput,
  normalizeCursorToolName,
} from './cursor.js';

const mocks = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@agor/core/agentic-integrations', () => ({
  loadManagedAgenticToolSdk: vi.fn(async () => {
    const agent = {
      agentId: 'provider-thread-A',
      send: mocks.send,
      close: vi.fn(),
    };
    return { Agent: { create: vi.fn(async () => agent), resume: vi.fn(async () => agent) } };
  }),
}));
vi.mock('@agor/core/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: vi.fn(async () => []),
}));
vi.mock('../../db/feathers-repositories.js', () => ({
  createFeathersBackedRepositories: () => ({}),
}));
vi.mock('./git-safe-directory.js', () => ({ configureSessionGitSafeDirectories: vi.fn() }));
vi.mock('./base-executor.js', () => ({
  createStreamingCallbacks: () => ({}),
  stampGitStateAtTaskStart: vi.fn(),
  captureGitStateAtTaskEnd: vi.fn(),
  settleTaskFailure: vi.fn(),
}));

it('refreshes Cursor request identity without persisting the identity block as user text', async () => {
  const messagesCreate = vi.fn();
  mocks.send.mockResolvedValue({
    stream: async function* () {},
    wait: async () => ({ status: 'completed', result: '' }),
  });
  const services = {
    'config/resolve-api-key': { create: async () => ({ apiKey: 'test-key' }) },
    sessions: {
      get: async (id: string) => ({
        session_id: id,
        branch_id: 'branch-1',
        sdk_session_id: 'provider-thread-A',
      }),
    },
    branches: { get: async () => ({ path: '/workspace' }) },
    messages: { find: async () => [], create: messagesCreate },
    tasks: { patch: vi.fn() },
  };
  const client = { service: (name: keyof typeof services) => services[name] };
  for (const id of ['fork-B', 'fork-B', 'nested-C']) {
    await executeCursorTask({
      client: client as never,
      sessionId: id as SessionID,
      taskId: 'task-1' as TaskID,
      prompt: 'Inherited ID: A',
      abortController: new AbortController(),
    });
    expect(mocks.send).toHaveBeenLastCalledWith(
      expect.stringContaining(`Current Agor session ID: ${id}`),
      expect.objectContaining({ idempotencyKey: 'task-1' })
    );
    expect(messagesCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ content: 'Inherited ID: A' })
    );
  }
});

describe('Cursor SDK handler helpers', () => {
  it('persists thinking before assistant text', () => {
    expect(
      buildCursorAssistantContent({
        thinkingText: 'Reasoning trace',
        text: 'Final answer',
      })
    ).toEqual([
      { type: 'thinking', text: 'Reasoning trace' },
      { type: 'text', text: 'Final answer' },
    ]);
  });

  it('does not persist a thinking block that duplicates the final answer', () => {
    expect(
      buildCursorAssistantContent({
        thinkingText: 'Hello!  How can I help you today?',
        text: 'Hello! How can I help you today?',
      })
    ).toEqual([{ type: 'text', text: 'Hello! How can I help you today?' }]);
  });

  it('normalizes shell commands for existing Bash tool widgets', () => {
    const input = normalizeCursorToolInput({
      type: 'tool_call',
      call_id: 'call-1',
      name: 'run_terminal_cmd',
      status: 'running',
      args: { cmd: 'pnpm check' },
    } as never);

    expect(normalizeCursorToolName('run_terminal_cmd')).toBe('Bash');
    expect(input).toMatchObject({
      command: 'pnpm check',
      cursor_tool_name: 'run_terminal_cmd',
      status: 'running',
    });
  });

  it('normalizes file paths for existing file tool widgets', () => {
    const input = normalizeCursorToolInput({
      type: 'tool_call',
      call_id: 'call-2',
      name: 'edit',
      status: 'completed',
      args: { path: 'packages/executor/src/handlers/sdk/cursor.ts' },
    } as never);

    expect(normalizeCursorToolName('edit')).toBe('Edit');
    expect(input).toMatchObject({
      file_path: 'packages/executor/src/handlers/sdk/cursor.ts',
      cursor_tool_name: 'edit',
      status: 'completed',
    });
  });
});
