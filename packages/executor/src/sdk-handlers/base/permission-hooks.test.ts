import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const generatedIds = vi.hoisted(() => ({ value: 0 }));
vi.mock('@agor/core', () => ({
  generateId: vi.fn(() => `test-generated-id-${++generatedIds.value}`),
  // shortId is used in log lines inside permission-hooks; a passthrough
  // mock keeps test output legible without depending on real ID shape.
  shortId: vi.fn((id: string) => id),
}));

import { PermissionService } from '../../permissions/permission-service.js';
import {
  getInteractionAbortOutcome,
  isDaemonOwnedAbort,
  markCoordinatorTerminationAbort,
  markInteractionAbort,
} from '../../termination-state.js';
import { EMPTY_MCP_TOOL_PERMISSION_INDEX } from './mcp-tool-permissions.js';
import { createCanUseToolCallback } from './permission-hooks.js';

/**
 * Coverage for the post-#1177 `canUseTool` callback.
 *
 * The AskUserQuestion intercept and the bypass-mode workaround were both
 * removed when #1177 disallowed `AskUserQuestion` at the SDK layer. What
 * remains is the MCP auto-approve fast-path and the permission-request UI
 * flow — both worth direct tests so future refactors don't quietly regress.
 */
describe('createCanUseToolCallback', () => {
  const sessionId = 'test-session' as SessionID;
  const taskId = 'test-task' as TaskID;
  const noopOptions = {
    signal: new AbortController().signal,
  };

  function createBaseDeps() {
    const abortController = new AbortController();
    return {
      abortController,
      permissionService: {
        acquireInteraction: vi.fn().mockResolvedValue(vi.fn()),
        emitRequest: vi.fn(),
        waitForDecision: vi.fn(),
        cancelPendingRequests: vi.fn(),
      } as any,
      tasksService: {
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      messagesRepo: {
        findBySessionId: vi.fn().mockResolvedValue([]),
      } as any,
      messagesService: {
        create: vi.fn().mockResolvedValue(undefined),
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      sessionsService: {
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      mcpServerRepo: {
        findById: vi.fn(),
      } as any,
      mcpToolPermissions: EMPTY_MCP_TOOL_PERMISSION_INDEX,
      sessionMCPRepo: {
        findBySessionId: vi.fn().mockResolvedValue([]),
        listServers: vi.fn().mockResolvedValue([]),
      } as any,
    };
  }

  function createObservedDeps(
    interactionMode: 'interactive' | 'unattended' = 'interactive',
    timeoutMs = 60_000
  ) {
    const emitted = vi.fn().mockResolvedValue(undefined);
    const activity = vi.fn();
    const permissionService = new PermissionService(emitted, timeoutMs, interactionMode, activity);
    const waitForDecision = vi.spyOn(permissionService, 'waitForDecision');
    const deps = {
      ...createBaseDeps(),
      permissionService,
    };
    return { deps, permissionService, emitted, activity, waitForDecision };
  }

  function resolveLatestPermission(
    permissionService: PermissionService,
    emitted: ReturnType<typeof vi.fn>
  ): void {
    const request = emitted.mock.calls
      .filter(([event]) => event === 'permission:request')
      .at(-1)?.[1] as {
      requestId: string;
    };
    permissionService.resolvePermission({
      requestId: request.requestId,
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });
  }

  beforeEach(() => {
    generatedIds.value = 0;
    vi.clearAllMocks();
  });

  afterEach(() => vi.useRealTimers());

  describe('MCP auto-approve', () => {
    it('auto-allows tools from the built-in "agor" server without consulting the DB', async () => {
      const deps = createBaseDeps();
      const callback = createCanUseToolCallback(sessionId, taskId, deps);

      const toolInput = { sessionId };
      const result = await callback('mcp__agor__agor_sessions_get_current', toolInput, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual(toolInput);
      expect(result.updatedPermissions?.[0]?.behavior).toBe('allow');
      expect(result.updatedPermissions?.[0]?.destination).toBe('session');
      // The agor server is added dynamically — should NOT round-trip through the DB.
      expect(deps.sessionMCPRepo.findBySessionId).not.toHaveBeenCalled();
      expect(deps.sessionMCPRepo.listServers).not.toHaveBeenCalled();
      expect(deps.mcpServerRepo.findById).not.toHaveBeenCalled();
      // No permission UI involved.
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    });

    it('auto-allows tools from MCP servers that ARE attached to the session', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.listServers.mockResolvedValue([{ name: 'shortcut' }]);

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('mcp__shortcut__list_stories', {}, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(deps.sessionMCPRepo.listServers).toHaveBeenCalledWith(sessionId, true);
      expect(deps.sessionMCPRepo.findBySessionId).not.toHaveBeenCalled();
      expect(deps.mcpServerRepo.findById).not.toHaveBeenCalled();
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    });

    it('falls through to permission flow when an MCP server is NOT attached', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.listServers.mockResolvedValue([]); // no attached servers
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'denied',
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('mcp__random__do_thing', {}, noopOptions);

      // The MCP fast-path didn't match — the permission UI was consulted.
      expect(deps.permissionService.emitRequest).toHaveBeenCalledTimes(1);
      expect(result.behavior).toBe('deny');
    });
  });

  describe('Permission request flow', () => {
    it('creates no message, status, event, waiter, or waiting pulse when unattended', async () => {
      const { deps, emitted, activity, waitForDecision } = createObservedDeps('unattended');

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(deps.messagesRepo.findBySessionId).not.toHaveBeenCalled();
      expect(deps.messagesService.create).not.toHaveBeenCalled();
      expect(deps.messagesService.patch).not.toHaveBeenCalled();
      expect(deps.tasksService.patch).not.toHaveBeenCalled();
      expect(deps.sessionsService.patch).not.toHaveBeenCalled();
      expect(emitted).not.toHaveBeenCalled();
      expect(waitForDecision).not.toHaveBeenCalled();
      expect(activity).not.toHaveBeenCalled();
    });

    it('serializes three requests with exactly one artifact, event, waiter, and decision each', async () => {
      const { deps, permissionService, emitted, activity, waitForDecision } = createObservedDeps();
      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const requests = ['first', 'second', 'third'].map((label) =>
        callback('Bash', { command: label }, { signal: deps.abortController.signal })
      );

      await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledTimes(1));
      expect(
        activity.mock.calls.filter(([event]) => event.type === 'waiting_started')
      ).toHaveLength(1);
      resolveLatestPermission(permissionService, emitted);
      await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledTimes(2));
      expect(
        activity.mock.calls.filter(([event]) => event.type === 'waiting_started')
      ).toHaveLength(2);
      expect(
        activity.mock.calls.filter(([event]) => event.type === 'waiting_finished')
      ).toHaveLength(1);
      resolveLatestPermission(permissionService, emitted);
      await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledTimes(3));
      resolveLatestPermission(permissionService, emitted);

      await expect(Promise.all(requests)).resolves.toEqual([
        expect.objectContaining({ behavior: 'allow' }),
        expect.objectContaining({ behavior: 'allow' }),
        expect.objectContaining({ behavior: 'allow' }),
      ]);
      expect(deps.messagesService.create).toHaveBeenCalledTimes(3);
      expect(deps.messagesService.patch).toHaveBeenCalledTimes(3);
      expect(deps.tasksService.patch).toHaveBeenCalledTimes(6);
      expect(deps.sessionsService.patch).toHaveBeenCalledTimes(6);
      expect(emitted.mock.calls.filter(([event]) => event === 'permission:request')).toHaveLength(
        3
      );
      expect(waitForDecision).toHaveBeenCalledTimes(3);
      expect(
        activity.mock.calls.filter(([event]) => event.type === 'waiting_started')
      ).toHaveLength(3);
      expect(
        activity.mock.calls.filter(([event]) => event.type === 'waiting_finished')
      ).toHaveLength(3);
    });

    it('releases queued requests after an active artifact error', async () => {
      const { deps } = createObservedDeps();
      deps.messagesRepo.findBySessionId.mockRejectedValueOnce(new Error('artifact failed'));
      const callback = createCanUseToolCallback(sessionId, taskId, deps);

      await expect(
        Promise.all([
          callback('Bash', { command: 'first' }, { signal: deps.abortController.signal }),
          callback('Bash', { command: 'second' }, { signal: deps.abortController.signal }),
        ])
      ).resolves.toEqual([
        expect.objectContaining({ behavior: 'deny', message: 'artifact failed' }),
        expect.objectContaining({ behavior: 'deny' }),
      ]);
      expect(deps.messagesRepo.findBySessionId).toHaveBeenCalledOnce();
    });

    it('releases and invalidates queued requests after an active timeout', async () => {
      vi.useFakeTimers();
      const { deps } = createObservedDeps('interactive', 1);
      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const requests = [
        callback('Bash', { command: 'first' }, { signal: deps.abortController.signal }),
        callback('Bash', { command: 'second' }, { signal: deps.abortController.signal }),
      ];
      await Promise.resolve();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);

      await expect(Promise.all(requests)).resolves.toEqual([
        expect.objectContaining({ behavior: 'deny', message: expect.stringMatching(/timed out/i) }),
        expect.objectContaining({ behavior: 'deny' }),
      ]);
      expect(deps.messagesService.create).toHaveBeenCalledOnce();
    });

    it('releases and invalidates queued requests when the Task terminates', async () => {
      const { deps } = createObservedDeps();
      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const requests = [
        callback('Bash', { command: 'first' }, { signal: deps.abortController.signal }),
        callback('Bash', { command: 'second' }, { signal: deps.abortController.signal }),
      ];
      await vi.waitFor(() => expect(deps.messagesService.create).toHaveBeenCalledOnce());
      markCoordinatorTerminationAbort(deps.abortController);
      deps.abortController.abort();

      await expect(Promise.all(requests)).resolves.toEqual([
        expect.objectContaining({ behavior: 'deny' }),
        expect.objectContaining({ behavior: 'deny' }),
      ]);
      expect(deps.messagesService.create).toHaveBeenCalledOnce();
    });

    it('approves a tool when the UI returns allow', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'approved',
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ command: 'ls' });
      // No persistence rule emitted when remember=false.
      expect(result.updatedPermissions).toBeUndefined();
      expect(deps.tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
        status: 'awaiting_permission',
      });
      expect(deps.tasksService.patch).toHaveBeenNthCalledWith(2, taskId, {
        status: 'running',
      });
      expect(deps.permissionService.acquireInteraction).toHaveBeenCalledTimes(1);
    });

    it('emits an SDK persistence rule when the user picks "remember"', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'approved',
        remember: true,
        scope: 'project',
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedPermissions).toEqual([
        {
          type: 'addRules',
          rules: [{ toolName: 'Bash' }],
          behavior: 'allow',
          destination: 'projectSettings',
        },
      ]);
    });

    it('denies only the tool and restores active execution when the UI returns deny', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'denied',
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('Bash');
      expect(deps.tasksService.patch).toHaveBeenNthCalledWith(1, taskId, {
        status: 'awaiting_permission',
      });
      expect(deps.tasksService.patch).toHaveBeenNthCalledWith(2, taskId, {
        status: 'running',
      });
      expect(deps.permissionService.cancelPendingRequests).not.toHaveBeenCalled();
      expect(deps.abortController.signal.aborted).toBe(false);
      expect(getInteractionAbortOutcome(deps.abortController)).toBeUndefined();
      expect(deps.sessionsService.patch).toHaveBeenLastCalledWith(sessionId, {
        status: 'running',
        ready_for_prompt: false,
      });
      const permissionMessage = deps.messagesService.create.mock.calls[0]?.[0];
      expect(deps.messagesService.patch).toHaveBeenCalledWith(
        permissionMessage.message_id,
        expect.objectContaining({
          content: expect.objectContaining({
            status: 'denied',
            approved_by: 'test-user',
          }),
        })
      );
    });

    it('aborts the runtime with an interaction_timeout outcome when the request times out', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'timed_out',
        remember: false,
        decidedBy: 'system',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toMatch(/timed out/i);
      expect(deps.abortController.signal.aborted).toBe(true);
      expect(getInteractionAbortOutcome(deps.abortController)).toMatchObject({
        cause: 'interaction_timeout',
        errorMessage: expect.stringMatching(/timed out/i),
      });
      expect(deps.tasksService.patch).not.toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ status: 'timed_out' })
      );
    });

    it('acquires the PermissionService interaction gate for the full timed-out flow', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'timed_out',
        remember: false,
        decidedBy: 'system',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      await callback('Bash', { command: 'ls' }, noopOptions);

      expect(deps.permissionService.acquireInteraction).toHaveBeenCalledTimes(1);
    });

    it('does not replace daemon-owned termination with a permission failure', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'cancelled',
        remember: false,
        decidedBy: 'system',
        reason: 'Cancelled',
      });
      markCoordinatorTerminationAbort(deps.abortController);
      deps.abortController.abort();

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      await expect(callback('Bash', { command: 'ls' }, noopOptions)).resolves.toMatchObject({
        behavior: 'deny',
      });

      markInteractionAbort(deps.abortController, {
        cause: 'interaction_unavailable',
        errorMessage: 'must not replace daemon ownership',
      });
      expect(isDaemonOwnedAbort(deps.abortController)).toBe(true);
      expect(getInteractionAbortOutcome(deps.abortController)).toBeUndefined();
    });
  });
});
