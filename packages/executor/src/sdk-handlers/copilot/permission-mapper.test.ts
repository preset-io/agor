import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { buildMcpToolPermissionIndex } from '../base/mcp-tool-permissions.js';
import { createPermissionHandler } from './permission-mapper.js';

describe('createPermissionHandler', () => {
  it('restores a task to running after interactive permission approval', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const tasksService = { patch: vi.fn().mockResolvedValue(undefined) };
    const messagesService = {
      create: vi.fn().mockResolvedValue(undefined),
      patch: vi.fn().mockResolvedValue(undefined),
    };
    const handler = createPermissionHandler(sessionId, taskId, 'ask', {
      permissionService: {
        emitRequest: vi.fn(),
        waitForDecision: vi.fn().mockResolvedValue({
          allow: true,
          timedOut: false,
          remember: false,
          decidedBy: 'test-user',
        }),
        cancelPendingRequests: vi.fn(),
      } as any,
      tasksService: tasksService as any,
      sessionsRepo: {} as any,
      messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) } as any,
      messagesService: messagesService as any,
      sessionsService: { patch: vi.fn().mockResolvedValue(undefined) } as any,
      permissionLocks: new Map(),
    });

    const result = await handler({
      kind: 'shell',
      command: 'ls',
      toolCallId: 'call-1',
    } as any);

    expect(result).toEqual({ kind: 'approved' });
    expect(tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
    expect(messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({
          status: 'approved',
          approved_by: 'test-user',
        }),
      })
    );
  });

  it('denies only the tool and restores active execution', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const tasksService = { patch: vi.fn().mockResolvedValue(undefined) };
    const sessionsService = { patch: vi.fn().mockResolvedValue(undefined) };
    const messagesService = {
      create: vi.fn().mockResolvedValue(undefined),
      patch: vi.fn().mockResolvedValue(undefined),
    };
    const permissionService = {
      emitRequest: vi.fn(),
      waitForDecision: vi.fn().mockResolvedValue({
        allow: false,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      }),
      cancelPendingRequests: vi.fn(),
    };
    const handler = createPermissionHandler(sessionId, taskId, 'ask', {
      permissionService: permissionService as any,
      tasksService: tasksService as any,
      sessionsRepo: {} as any,
      messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) } as any,
      messagesService: messagesService as any,
      sessionsService: sessionsService as any,
      permissionLocks: new Map(),
    });

    const result = await handler({
      kind: 'shell',
      command: 'ls',
      toolCallId: 'call-1',
    } as any);

    expect(result).toEqual({
      kind: 'denied-interactively-by-user',
      feedback: 'Permission denied for: Shell: ls',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
      status: 'awaiting_permission',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(2, taskId, { status: 'running' });
    expect(permissionService.cancelPendingRequests).not.toHaveBeenCalled();
    expect(sessionsService.patch).toHaveBeenLastCalledWith(sessionId, {
      status: 'running',
      ready_for_prompt: false,
    });
    expect(messagesService.patch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        content: expect.objectContaining({
          status: 'denied',
          approved_by: 'test-user',
        }),
      })
    );
  });

  it('terminalizes the task without attempting a post-revocation session patch on timeout', async () => {
    const sessionId = 'test-session' as SessionID;
    const taskId = 'test-task' as TaskID;
    const tasksService = { patch: vi.fn().mockResolvedValue(undefined) };
    const sessionsService = { patch: vi.fn().mockResolvedValue(undefined) };
    const handler = createPermissionHandler(sessionId, taskId, 'ask', {
      permissionService: {
        emitRequest: vi.fn(),
        waitForDecision: vi.fn().mockResolvedValue({
          allow: false,
          timedOut: true,
          remember: false,
          decidedBy: 'system',
        }),
        cancelPendingRequests: vi.fn(),
      },
      tasksService,
      sessionsRepo: {},
      messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) },
      messagesService: {
        create: vi.fn().mockResolvedValue(undefined),
        patch: vi.fn().mockResolvedValue(undefined),
      },
      sessionsService,
      permissionLocks: new Map(),
    } as never);

    const result = await handler({ kind: 'shell', command: 'ls', toolCallId: 'call-1' } as never);

    expect(result).toEqual({
      kind: 'denied-interactively-by-user',
      feedback: 'Permission request timed out for: Shell: ls',
    });
    expect(tasksService.patch).toHaveBeenNthCalledWith(2, taskId, {
      status: 'timed_out',
      completed_at: expect.any(String),
    });
    expect(sessionsService.patch).toHaveBeenCalledTimes(1);
    expect(sessionsService.patch).toHaveBeenNthCalledWith(1, sessionId, {
      status: 'awaiting_permission',
    });
  });
});

/**
 * Copilot cannot filter the tool list it offers the model, so this callback is
 * the ONLY place a switched-off tool can be stopped. It is also crowded with
 * shortcuts that return `approved` before any per-tool logic used to run —
 * `bypassPermissions` short-circuits the whole handler, and an attached server
 * auto-approves every tool on it. Each case below drives one of those paths.
 */
describe('createPermissionHandler - MCP tool_permissions', () => {
  const sessionId = 'test-session' as SessionID;
  const taskId = 'test-task' as TaskID;

  const index = buildMcpToolPermissionIndex([
    {
      mcp_server_id: 's1',
      name: 'sentry',
      tool_permissions: { delete_project: 'deny', update_issue: 'ask', list_issues: 'allow' },
    } as never,
  ]);

  /** Attached-and-listed, so the server-level fast path would approve it. */
  const deps = (extra: Record<string, unknown> = {}) =>
    ({
      permissionService: {
        emitRequest: vi.fn(),
        waitForDecision: vi
          .fn()
          .mockResolvedValue({ allow: true, timedOut: false, remember: false, decidedBy: 'u' }),
        cancelPendingRequests: vi.fn(),
      },
      tasksService: { patch: vi.fn().mockResolvedValue(undefined) },
      sessionsRepo: {},
      messagesRepo: { getNextIndexBySessionId: vi.fn().mockResolvedValue(0) },
      messagesService: { create: vi.fn(), patch: vi.fn() },
      sessionsService: { patch: vi.fn().mockResolvedValue(undefined) },
      permissionLocks: new Map(),
      sessionMCPRepo: { listServers: vi.fn().mockResolvedValue([{ name: 'sentry' }]) },
      mcpToolPermissions: index,
      ...extra,
    }) as never;

  const mcpRequest = (toolName: string) =>
    ({ kind: 'mcp', serverName: 'sentry', toolName, toolCallId: 'c1' }) as never;

  it('refuses a denied tool even though its server is attached', async () => {
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps());

    const result = await handler(mcpRequest('delete_project'), { sessionId });

    expect(result).toMatchObject({ kind: 'denied-by-permission-request-hook' });
  });

  it('still approves an allowed tool on the same server', async () => {
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps());

    // Positive control: the deny above is per tool, not the server going dark.
    expect(await handler(mcpRequest('list_issues'), { sessionId })).toEqual({ kind: 'approved' });
  });

  it('refuses a denied tool under bypassPermissions, which returns before the deps exist', async () => {
    const handler = createPermissionHandler(sessionId, taskId, 'bypassPermissions', deps());

    // The mode that skips every interactive path is exactly where a gate
    // placed further down would have been missed.
    expect(await handler(mcpRequest('delete_project'), { sessionId })).toMatchObject({
      kind: 'denied-by-permission-request-hook',
    });
    expect(await handler(mcpRequest('list_issues'), { sessionId })).toEqual({ kind: 'approved' });
  });

  it('fails an unanswerable "ask" closed rather than letting it become allow', async () => {
    const handler = createPermissionHandler(sessionId, taskId, 'bypassPermissions', deps());

    expect(await handler(mcpRequest('update_issue'), { sessionId })).toMatchObject({
      kind: 'denied-by-permission-request-hook',
    });
  });

  it('prompts for an "ask" tool instead of letting server attachment answer for the user', async () => {
    const emitRequest = vi.fn();
    const handler = createPermissionHandler(
      sessionId,
      taskId,
      'ask',
      deps({
        permissionService: {
          emitRequest,
          waitForDecision: vi
            .fn()
            .mockResolvedValue({ allow: true, timedOut: false, remember: false, decidedBy: 'u' }),
          cancelPendingRequests: vi.fn(),
        },
      })
    );

    const result = await handler(mcpRequest('update_issue'), { sessionId });

    expect(emitRequest).toHaveBeenCalled();
    expect(result).toEqual({ kind: 'approved' });
  });

  it('leaves servers with no configured permissions on their existing fast path', async () => {
    const handler = createPermissionHandler(sessionId, taskId, 'ask', deps());

    // Unconfigured must mean "unchanged behaviour", never an implicit deny.
    const result = await handler(
      { kind: 'mcp', serverName: 'other', toolName: 'whatever', toolCallId: 'c2' } as never,
      { sessionId }
    );
    expect(result).toEqual({ kind: 'approved' });
  });
});
