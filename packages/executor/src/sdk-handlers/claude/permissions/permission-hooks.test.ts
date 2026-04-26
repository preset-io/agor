import type { SessionID, TaskID } from '@agor/core/types';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@agor/core', () => ({
  generateId: vi.fn(() => 'test-generated-id'),
}));

import { createCanUseToolCallback } from './permission-hooks.js';

/**
 * Regression coverage for the AskUserQuestion widget fix.
 *
 * The Claude Agent SDK marks `AskUserQuestion` (and `ExitPlanMode`) with
 * `requiresUserInteraction: true`, which forces the SDK to invoke
 * `canUseTool` even when the session is in `bypassPermissions` mode. We
 * register the callback unconditionally and rely on the bypass fast-path
 * inside the callback to preserve bypass semantics for everything except
 * `AskUserQuestion`, which always routes through Agor's input-request UI.
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
      inputRequestService: {
        emitRequest: vi.fn(),
        waitForResponse: vi.fn(),
      } as any,
      tasksService: {
        patch: vi.fn().mockResolvedValue(undefined),
      } as any,
      sessionsRepo: {} as any,
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
      permissionLocks: new Map(),
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

  describe('bypass-mode fast-path', () => {
    it('auto-allows a regular tool in bypassPermissions without entering the permission flow', async () => {
      const deps = createBaseDeps();
      const callback = createCanUseToolCallback(sessionId, taskId, {
        ...deps,
        permissionMode: 'bypassPermissions',
      });

      const toolInput = { command: 'ls' };
      const result = await callback('Bash', toolInput, noopOptions);

      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: toolInput,
      });
      // None of the heavy permission/input-request machinery should fire.
      expect(deps.permissionService.emitRequest).not.toHaveBeenCalled();
      expect(deps.permissionService.waitForDecision).not.toHaveBeenCalled();
      expect(deps.messagesService.create).not.toHaveBeenCalled();
      expect(deps.tasksService.patch).not.toHaveBeenCalled();
    });

    // ExitPlanMode is the other built-in `requiresUserInteraction` tool.
    // The fast-path must auto-allow it in bypass mode — the bug we fixed
    // would otherwise force it through the SDK's default-deny path.
    it('auto-allows ExitPlanMode in bypassPermissions', async () => {
      const deps = createBaseDeps();
      const callback = createCanUseToolCallback(sessionId, taskId, {
        ...deps,
        permissionMode: 'bypassPermissions',
      });

      const toolInput = { plan: 'do the thing' };
      const result = await callback('ExitPlanMode', toolInput, noopOptions);

      expect(result).toEqual({
        behavior: 'allow',
        updatedInput: toolInput,
      });
      expect(deps.inputRequestService.emitRequest).not.toHaveBeenCalled();
    });

    it('does NOT short-circuit AskUserQuestion in bypass mode — intercept must run first', async () => {
      const deps = createBaseDeps();
      // Stub the full happy-path so the AskUserQuestion intercept resolves cleanly.
      deps.inputRequestService.waitForResponse.mockResolvedValue({
        timedOut: false,
        answers: ['option-a'],
        annotations: [],
        respondedBy: 'test-user',
      });

      const callback = createCanUseToolCallback(sessionId, taskId, {
        ...deps,
        permissionMode: 'bypassPermissions',
      });

      const toolInput = {
        questions: [{ question: 'pick one', header: 'h', options: [], multiSelect: false }],
      };
      const result = await callback('AskUserQuestion', toolInput, noopOptions);

      // Intercept ran (input-request emitted, message created, response awaited).
      expect(deps.inputRequestService.emitRequest).toHaveBeenCalledTimes(1);
      expect(deps.inputRequestService.waitForResponse).toHaveBeenCalledTimes(1);
      expect(deps.messagesService.create).toHaveBeenCalledTimes(1);

      // Result carries the user's answers, not the bypass fast-path's bare updatedInput.
      expect(result.behavior).toBe('allow');
      expect(result.updatedInput).toMatchObject({
        answers: ['option-a'],
      });
    });
  });
});
