import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMcpServersForSession: vi.fn(),
  sendAndWait: vi.fn(),
  configured: vi.fn(),
}));

// Configuration fixtures must not depend on the invoking executor's environment.
vi.mock('../../config.js', () => ({
  getDaemonUrl: vi.fn(async () => 'http://localhost:3030'),
}));

vi.mock('@agor/core/mcp', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agor/core/mcp')>()),
  getMcpServersForSession: mocks.getMcpServersForSession,
  resolveScopedMCPAuthHeaders: vi.fn(async () => ({ Authorization: 'Bearer external-token' })),
}));

vi.mock('@agor/core/agentic-integrations', () => ({
  loadManagedAgenticToolSdk: vi.fn(async () => ({
    CopilotClient: class {
      start = vi.fn();
      stop = vi.fn();
      createSession = this.resumeSession;
      async resumeSession(idOrOptions: unknown, options?: unknown) {
        mocks.configured(options ?? idOrOptions);
        return {
          sessionId: 'provider-thread-A',
          setModel: vi.fn(),
          on: vi.fn(),
          disconnect: vi.fn(),
          sendAndWait: mocks.sendAndWait,
        };
      }
    },
  })),
}));

import { CopilotPromptService } from './prompt-service.js';

describe('CopilotPromptService MCP identity scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getMcpServersForSession.mockResolvedValue([
      {
        server: {
          name: 'external',
          transport: 'http',
          url: 'https://example.com/mcp',
        },
      },
    ]);
  });

  it('sends current execution identity on each resumed provider request', async () => {
    const service = new CopilotPromptService(
      {} as never,
      {
        findById: vi.fn().mockResolvedValue({
          created_by: 'session-owner',
          sdk_session_id: 'provider-thread-A',
          branch_id: 'branch-1',
          mcp_token: 'test-token',
        }),
      } as never,
      undefined,
      { findById: vi.fn().mockResolvedValue({ path: '/workspace' }) } as never
    );
    for (const id of ['fork-B', 'fork-B', 'nested-C']) {
      for await (const _event of service.promptSessionStreaming(
        id as SessionID,
        'Inherited ID: A'
      )) {
        // Consume the provider turn.
      }
      expect(mocks.configured.mock.lastCall?.[0]).toMatchObject({
        mcpServers: {
          agor: {
            headers: {
              Authorization: 'Bearer test-token',
              'x-agor-mcp-client': 'copilot',
            },
          },
        },
      });
      expect(mocks.configured.mock.lastCall?.[0].mcpServers.external.headers).toEqual({
        Authorization: 'Bearer external-token',
      });
      expect(mocks.sendAndWait).toHaveBeenLastCalledWith(
        {
          prompt: expect.stringContaining(
            `Inherited ID: A\n\n<agor_session_identity>\nCurrent Agor session ID: ${id}`
          ),
        },
        expect.any(Number)
      );
      expect(mocks.sendAndWait.mock.calls.at(-1)?.[0].prompt).not.toContain('provider-thread-A');
    }
  });

  it('hydrates OAuth for the task creator while filtering definitions by session owner', async () => {
    const service = new CopilotPromptService(
      {} as never,
      {
        findById: vi.fn().mockResolvedValue({ created_by: 'session-owner' }),
      } as never,
      {} as never,
      undefined,
      undefined,
      undefined,
      {} as never,
      undefined,
      undefined,
      undefined,
      {
        get: vi.fn().mockResolvedValue({ created_by: 'task-creator' }),
      } as never,
      undefined,
      {} as never
    );

    await (
      service as unknown as {
        buildMcpServers(sessionId: string, taskId: string): Promise<Record<string, unknown>>;
      }
    ).buildMcpServers('session-1', 'task-1');

    expect(mocks.getMcpServersForSession).toHaveBeenCalledWith(
      'session-1',
      expect.objectContaining({
        forUserId: 'task-creator',
      }),
      { toolFiltering: 'intercept' }
    );
  });
});
