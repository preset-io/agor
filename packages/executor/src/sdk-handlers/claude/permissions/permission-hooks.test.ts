import type { SessionID, TaskID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core', () => ({
  generateId: vi.fn(() => 'test-generated-id'),
}));

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
    return {
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
      sessionMCPRepo: {
        findBySessionId: vi.fn().mockResolvedValue([]),
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
      expect(deps.mcpServerRepo.findById).not.toHaveBeenCalled();
      // No permission UI involved.
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    });

    it('auto-allows tools from MCP servers that ARE attached to the session', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.findBySessionId.mockResolvedValue([{ mcp_server_id: 'srv-1' }]);
      deps.mcpServerRepo.findById.mockResolvedValue({ name: 'shortcut' });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('mcp__shortcut__list_stories', {}, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
    });

    it('falls through to permission flow when an MCP server is NOT attached', async () => {
      const deps = createBaseDeps();
      deps.sessionMCPRepo.findBySessionId.mockResolvedValue([]); // no attached servers
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: false,
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
        allow: true,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toEqual({ command: 'ls' });
      // No persistence rule emitted when remember=false.
      expect(result.updatedPermissions).toBeUndefined();
      // Lock was acquired AND released.
      expect(deps.permissionLocks.size).toBe(0);
    });

    it('emits an SDK persistence rule when the user picks "remember"', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: true,
        timedOut: false,
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

    it('denies the tool and cancels pending requests when the UI returns deny', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: false,
        remember: false,
        decidedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toContain('Bash');
      expect(deps.permissionService.cancelPendingRequests).toHaveBeenCalledWith(sessionId);
      // Session driven back to idle so the user can re-prompt.
      expect(deps.sessionsService.patch).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ status: 'idle' })
      );
    });

    it('marks task and session timed_out when the permission request times out', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: true,
        remember: false,
        decidedBy: 'system',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, deps);
      const result = await callback('Bash', { command: 'ls' }, noopOptions);

      expect(result.behavior).toBe('deny');
      expect(result.message).toMatch(/timed out/i);
      expect(deps.tasksService.patch).toHaveBeenCalledWith(
        taskId,
        expect.objectContaining({ status: 'timed_out' })
      );
      expect(deps.sessionsService.patch).toHaveBeenCalledWith(
        sessionId,
        expect.objectContaining({ status: 'timed_out', ready_for_prompt: true })
      );
    });

    it('always releases the per-session permission lock, even on timeout', async () => {
      const deps = createBaseDeps();
      deps.permissionService.waitForDecision.mockResolvedValue({
        allow: false,
        timedOut: true,
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
  });
});
