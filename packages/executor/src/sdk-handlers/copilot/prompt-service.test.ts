import type { SessionID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getMcpServersForSession: vi.fn(),
  sendAndWait: vi.fn(),
  configured: vi.fn(),
  stop: vi.fn(),
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
      stop = mocks.stop;
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

import { resolveScopedMCPAuthHeaders } from '@agor/core/mcp';
import {
  dcrAndMachineInstalls,
  realMcpScoping,
  shippedAsanaInstall,
} from '../../../test/helpers/real-mcp-scoping.js';
import { expectSignalQuiescence } from '../../../test/helpers/signal-quiescence.js';
import { CopilotPromptService } from './prompt-service.js';

describe('CopilotPromptService MCP identity scoping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.stop.mockResolvedValue([]);
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

  it.each(['success', 'rejection', 'errors'])(
    'requires successful CLI teardown even when Stop succeeds (%s)',
    async (outcome) => {
      const controller = new AbortController();
      const service = new CopilotPromptService(
        {} as never,
        {
          findById: vi.fn().mockResolvedValue({
            created_by: 'owner',
            branch_id: 'branch-1',
            sdk_session_id: 'provider-thread-A',
          }),
        } as never,
        undefined,
        { findById: vi.fn().mockResolvedValue({ path: '/workspace' }) } as never
      );
      mocks.sendAndWait.mockImplementationOnce(async () => {
        expect(service.stopTask('session-1' as SessionID)).toEqual({ success: true });
        controller.abort();
        throw Object.assign(new Error('aborted'), { name: 'AbortError' });
      });
      if (outcome === 'rejection') mocks.stop.mockRejectedValueOnce(new Error('stop failed'));
      if (outcome === 'errors') mocks.stop.mockResolvedValueOnce([new Error('disconnect failed')]);
      for await (const _ of service.promptSessionStreaming(
        'session-1' as SessionID,
        'hello',
        undefined,
        undefined,
        controller
      )) {
        /* Drain cancellation and actual finally. */
      }
      expect(mocks.stop).toHaveBeenCalledOnce();
      await expectSignalQuiescence(controller, outcome === 'success');
    }
  );

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

  it('withholds a configured-client server without a grant and tells the agent per turn', async () => {
    const dcr = {
      mcp_server_id: 'dcr-id',
      name: 'dcr',
      scope: 'global',
      enabled: true,
      transport: 'http',
      url: 'https://mcp.dcr.test/mcp',
      auth: { type: 'oauth' },
    };
    const real = await realMcpScoping([await shippedAsanaInstall('per_user'), dcr as never]);
    mocks.getMcpServersForSession.mockImplementationOnce(real.getMcpServersForSession);
    vi.mocked(resolveScopedMCPAuthHeaders)
      .mockImplementationOnce(real.resolveScopedMCPAuthHeaders)
      .mockImplementationOnce(real.resolveScopedMCPAuthHeaders);
    const service = new CopilotPromptService(
      {} as never,
      {
        findById: vi.fn().mockResolvedValue({
          created_by: 'user-a',
          branch_id: 'branch-1',
          sdk_session_id: 'provider-thread-A',
        }),
      } as never,
      {} as never,
      { findById: vi.fn().mockResolvedValue({ path: '/workspace' }) } as never
    );
    for await (const _event of service.promptSessionStreaming('session-1' as SessionID, 'hi')) {
      // Consume the provider turn.
    }

    const { mcpServers } = mocks.configured.mock.lastCall![0];
    expect(mcpServers.asana).toBeUndefined();
    // Copilot marks a DCR server as needing auth and carries on: still loaded.
    expect(mcpServers.dcr).toMatchObject({ url: 'https://mcp.dcr.test/mcp' });
    const { prompt } = mocks.sendAndWait.mock.lastCall![0];
    expect(prompt).toMatch(/^hi\n\n<agor_session_identity>/);
    expect(prompt).toContain('- mcpServerId: asana-id, label: "Asana"');
    expect(prompt).toContain('- mcpServerId: dcr-id, label: "dcr"');
    expect(prompt).toContain('unavailable until the user connects them');
  });

  it.each(['per_user', 'shared'] as const)(
    'asks to retry, not to Connect, when the credential lookup fails (%s)',
    async (mode) => {
      const real = await realMcpScoping(
        [await shippedAsanaInstall(mode), ...dcrAndMachineInstalls()],
        { lookupFails: true }
      );
      mocks.getMcpServersForSession.mockImplementationOnce(real.getMcpServersForSession);
      for (let i = 0; i < 3; i++) {
        vi.mocked(resolveScopedMCPAuthHeaders).mockImplementationOnce(
          real.resolveScopedMCPAuthHeaders
        );
      }
      const service = new CopilotPromptService(
        {} as never,
        {
          findById: vi.fn().mockResolvedValue({
            created_by: 'user-a',
            branch_id: 'branch-1',
            sdk_session_id: 'provider-thread-A',
          }),
        } as never,
        {} as never,
        { findById: vi.fn().mockResolvedValue({ path: '/workspace' }) } as never
      );
      for await (const _event of service.promptSessionStreaming('session-1' as SessionID, 'hi')) {
        // Consume the provider turn.
      }

      const { mcpServers } = mocks.configured.mock.lastCall![0];
      expect(mcpServers.asana).toBeUndefined();
      expect(mcpServers.m2m).toBeUndefined();
      // DCR keeps today's behavior on a failed lookup: loaded, not in the notice.
      expect(mcpServers.dcr).toMatchObject({ url: 'https://mcp.dcr.test/mcp' });
      const { prompt } = mocks.sendAndWait.mock.lastCall![0];
      expect(prompt).toMatch(/couldn't load the sign-in[^#]*asana-id/);
      expect(prompt).toMatch(/machine \(client-credentials\)[^#]*m2m-id/);
      expect(prompt).not.toContain('never connected');
      expect(prompt).not.toContain('dcr-id');
    }
  );
});
