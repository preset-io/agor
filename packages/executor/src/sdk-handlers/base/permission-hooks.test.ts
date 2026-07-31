import type { SessionID, TaskID } from '@agor/core/types';
import { TaskStatus } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core', () => ({
  generateId: vi.fn(() => 'test-generated-id'),
  // shortId is used in log lines inside permission-hooks; a passthrough
  // mock keeps test output legible without depending on real ID shape.
  shortId: vi.fn((id: string) => id),
}));

import { EMPTY_MCP_TOOL_PERMISSION_INDEX } from './mcp-tool-permissions.js';
import {
  getInteractionAbortOutcome,
  isDaemonOwnedAbort,
  markCoordinatorTerminationAbort,
  markInteractionAbort,
} from '../../termination-state.js';
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
      permissionLocks: new Map<SessionID, Promise<void>>(),
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

  beforeEach(() => {
    vi.clearAllMocks();
  });

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
      // Lock was acquired AND released.
      expect(deps.permissionLocks.size).toBe(0);
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
      expect(deps.messagesService.patch).toHaveBeenCalledWith(
        'test-generated-id',
        expect.objectContaining({
          content: expect.objectContaining({
            status: 'denied',
            approved_by: 'test-user',
          }),
        })
      );
    });

    it('aborts the runtime with a timed_out outcome when the permission request times out', async () => {
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
        status: 'timed_out',
        errorMessage: expect.stringMatching(/timed out/i),
      });
      expect(deps.tasksService.patch).not.toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ status: 'timed_out' })
      );
    });

    it('always releases the per-session permission lock, even on timeout', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        outcome: 'timed_out',
        remember: false,
        decidedBy: 'system',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      await callback('Bash', { command: 'ls' }, noopOptions);

      // Lock is removed from the map after the callback completes — without
      // this guarantee, every subsequent tool call on the same session would
      // wait forever for a never-resolving promise.
      expect(deps.permissionLocks.has(sessionId)).toBe(false);
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
        status: TaskStatus.FAILED,
        errorMessage: 'must not replace daemon ownership',
      });
      expect(isDaemonOwnedAbort(deps.abortController)).toBe(true);
      expect(getInteractionAbortOutcome(deps.abortController)).toBeUndefined();
    });
  });
});
