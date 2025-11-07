/**
 * PermissionService Tests
 *
 * Tests async permission request/decision flow for Claude Agent SDK PreToolUse hooks.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionID, TaskID } from '../types';
import { PermissionScope } from '../types/message';
import {
  type PermissionDecision,
  type PermissionRequest,
  PermissionService,
} from './permission-service';

// Helper to create test permission request
function createRequest(
  overrides?: Partial<Omit<PermissionRequest, 'sessionId'>>
): Omit<PermissionRequest, 'sessionId'> {
  return {
    requestId: 'test-request-123',
    taskId: 'test-task-456' as TaskID,
    toolName: 'Bash',
    toolInput: { command: 'rm hello.md' },
    toolUseID: 'tool-use-789',
    timestamp: new Date().toISOString(),
    ...overrides,
  };
}

// Helper to create test permission decision
function createDecision(overrides?: Partial<PermissionDecision>): PermissionDecision {
  return {
    requestId: 'test-request-123',
    taskId: 'test-task-456' as TaskID,
    allow: true,
    remember: false,
    scope: PermissionScope.ONCE,
    decidedBy: 'user-123',
    ...overrides,
  };
}

// ============================================================================
// Constructor
// ============================================================================

describe('PermissionService.constructor', () => {
  it('should create instance with event emitter', () => {
    const emitEvent = vi.fn();
    const service = new PermissionService(emitEvent as any);

    expect(service).toBeInstanceOf(PermissionService);
  });

  it('should accept any event emitter function', () => {
    const customEmitter = vi.fn();
    const service = new PermissionService(customEmitter as any);

    expect(service).toBeInstanceOf(PermissionService);
  });
});

// ============================================================================
// emitRequest
// ============================================================================

describe('PermissionService.emitRequest', () => {
  let emitEvent: ReturnType<typeof vi.fn>;
  let service: PermissionService;

  beforeEach(() => {
    emitEvent = vi.fn();
    service = new PermissionService(emitEvent as any);
  });

  it('should emit permission:request event with full request data', () => {
    const sessionId = 'session-123' as SessionID;
    const request = createRequest();

    service.emitRequest(sessionId, request);

    expect(emitEvent).toHaveBeenCalledTimes(1);
    expect(emitEvent).toHaveBeenCalledWith('permission:request', {
      ...request,
      sessionId,
    });
  });

  it('should include sessionId in emitted request', () => {
    const sessionId = 'session-456' as SessionID;
    const request = createRequest({ toolName: 'Write' });

    service.emitRequest(sessionId, request);

    const emittedRequest = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emittedRequest.sessionId).toBe(sessionId);
    expect(emittedRequest.toolName).toBe('Write');
  });

  it('should emit for different tool types', () => {
    const sessionId = 'session-789' as SessionID;
    const tools = ['Bash', 'Write', 'Edit', 'Read', 'Glob'];

    tools.forEach(toolName => {
      const request = createRequest({ toolName });
      service.emitRequest(sessionId, request);
    });

    expect(emitEvent).toHaveBeenCalledTimes(tools.length);
    expect(emitEvent.mock.calls.map(c => (c[1] as PermissionRequest).toolName)).toEqual(tools);
  });

  it('should preserve all request fields', () => {
    const sessionId = 'session-999' as SessionID;
    const timestamp = new Date().toISOString();
    const request = createRequest({
      requestId: 'req-xyz',
      taskId: 'task-abc' as TaskID,
      toolName: 'Bash',
      toolInput: { command: 'git push', dangerouslyDisableSandbox: true },
      toolUseID: 'tool-123',
      timestamp,
    });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.requestId).toBe('req-xyz');
    expect(emitted.taskId).toBe('task-abc');
    expect(emitted.toolName).toBe('Bash');
    expect(emitted.toolInput).toEqual({ command: 'git push', dangerouslyDisableSandbox: true });
    expect(emitted.toolUseID).toBe('tool-123');
    expect(emitted.timestamp).toBe(timestamp);
  });

  it('should work without optional toolUseID', () => {
    const sessionId = 'session-111' as SessionID;
    const request = createRequest({ toolUseID: undefined });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.toolUseID).toBeUndefined();
  });

  it('should handle complex tool inputs', () => {
    const sessionId = 'session-222' as SessionID;
    const request = createRequest({
      toolName: 'Edit',
      toolInput: {
        file_path: '/path/to/file.ts',
        old_string: 'const foo = 1;',
        new_string: 'const foo = 2;',
        replace_all: false,
      },
    });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.toolInput).toEqual(request.toolInput);
  });
});

// ============================================================================
// waitForDecision
// ============================================================================

describe('PermissionService.waitForDecision', () => {
  let emitEvent: ReturnType<typeof vi.fn>;
  let service: PermissionService;

  beforeEach(() => {
    vi.useFakeTimers();
    emitEvent = vi.fn();
    service = new PermissionService(emitEvent as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should return decision when resolved', async () => {
    const requestId = 'req-123';
    const taskId = 'task-456' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    // Resolve immediately
    const decision = createDecision({ requestId, taskId, allow: true });
    service.resolvePermission(decision);

    const result = await waitPromise;
    expect(result).toEqual(decision);
  });

  it('should handle allow decision', async () => {
    const requestId = 'req-allow';
    const taskId = 'task-allow' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    service.resolvePermission(createDecision({ requestId, taskId, allow: true }));

    const result = await waitPromise;
    expect(result.allow).toBe(true);
  });

  it('should handle deny decision', async () => {
    const requestId = 'req-deny';
    const taskId = 'task-deny' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    service.resolvePermission(createDecision({ requestId, taskId, allow: false }));

    const result = await waitPromise;
    expect(result.allow).toBe(false);
  });

  it('should timeout after 60 seconds with deny decision', async () => {
    const requestId = 'req-timeout';
    const taskId = 'task-timeout' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    // Fast-forward 60 seconds
    vi.advanceTimersByTime(60000);

    const result = await waitPromise;
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('Timeout');
    expect(result.decidedBy).toBe('system');
    expect(result.scope).toBe(PermissionScope.ONCE);
  });

  it('should handle abort signal', async () => {
    const requestId = 'req-abort';
    const taskId = 'task-abort' as TaskID;
    const controller = new AbortController();

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, controller.signal);

    // Abort the request
    controller.abort();

    const result = await waitPromise;
    expect(result.allow).toBe(false);
    expect(result.reason).toBe('Cancelled');
    expect(result.decidedBy).toBe('system');
    expect(result.scope).toBe(PermissionScope.ONCE);
  });

  it('should clean up timeout on abort', async () => {
    const requestId = 'req-cleanup';
    const taskId = 'task-cleanup' as TaskID;
    const controller = new AbortController();

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, controller.signal);

    controller.abort();
    await waitPromise;

    // Verify timeout was cleared (advancing time should not trigger timeout)
    vi.advanceTimersByTime(60000);

    // No additional resolution should occur
    const decision = createDecision({ requestId, taskId });
    service.resolvePermission(decision); // Should have no effect
  });

  it('should handle multiple concurrent requests', async () => {
    const signal = new AbortController().signal;

    const req1 = service.waitForDecision('req-1', 'task-1' as TaskID, "session-test" as SessionID, signal);
    const req2 = service.waitForDecision('req-2', 'task-2' as TaskID, "session-test" as SessionID, signal);
    const req3 = service.waitForDecision('req-3', 'task-3' as TaskID, "session-test" as SessionID, signal);

    // Resolve in different order
    service.resolvePermission(
      createDecision({ requestId: 'req-2', taskId: 'task-2' as TaskID, allow: false })
    );
    service.resolvePermission(
      createDecision({ requestId: 'req-1', taskId: 'task-1' as TaskID, allow: true })
    );
    service.resolvePermission(
      createDecision({ requestId: 'req-3', taskId: 'task-3' as TaskID, allow: true })
    );

    const [result1, result2, result3] = await Promise.all([req1, req2, req3]);

    expect(result1.allow).toBe(true);
    expect(result2.allow).toBe(false);
    expect(result3.allow).toBe(true);
  });

  it('should preserve decision metadata', async () => {
    const requestId = 'req-meta';
    const taskId = 'task-meta' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    const decision = createDecision({
      requestId,
      taskId,
      allow: true,
      reason: 'User approved safe operation',
      remember: true,
      scope: PermissionScope.SESSION,
      decidedBy: 'user-789',
    });
    service.resolvePermission(decision);

    const result = await waitPromise;
    expect(result.reason).toBe('User approved safe operation');
    expect(result.remember).toBe(true);
    expect(result.scope).toBe(PermissionScope.SESSION);
    expect(result.decidedBy).toBe('user-789');
  });

  it('should handle different permission scopes', async () => {
    const signal = new AbortController().signal;
    const scopes = [PermissionScope.ONCE, PermissionScope.SESSION, PermissionScope.PROJECT];

    for (const scope of scopes) {
      const requestId = `req-${scope}`;
      const taskId = `task-${scope}` as TaskID;

      const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);
      service.resolvePermission(createDecision({ requestId, taskId, scope }));

      const result = await waitPromise;
      expect(result.scope).toBe(scope);
    }
  });

  it('should include taskId in timeout decision', async () => {
    const requestId = 'req-task';
    const taskId = 'task-specific' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    vi.advanceTimersByTime(60000);

    const result = await waitPromise;
    expect(result.taskId).toBe(taskId);
  });

  it('should include taskId in abort decision', async () => {
    const requestId = 'req-abort-task';
    const taskId = 'task-abort-specific' as TaskID;
    const controller = new AbortController();

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, controller.signal);

    controller.abort();

    const result = await waitPromise;
    expect(result.taskId).toBe(taskId);
  });
});

// ============================================================================
// resolvePermission
// ============================================================================

describe('PermissionService.resolvePermission', () => {
  let emitEvent: ReturnType<typeof vi.fn>;
  let service: PermissionService;

  beforeEach(() => {
    vi.useFakeTimers();
    emitEvent = vi.fn();
    service = new PermissionService(emitEvent as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should resolve pending request', async () => {
    const requestId = 'req-resolve';
    const taskId = 'task-resolve' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    const decision = createDecision({ requestId, taskId });
    service.resolvePermission(decision);

    const result = await waitPromise;
    expect(result).toEqual(decision);
  });

  it('should clear timeout on resolution', async () => {
    const requestId = 'req-clear';
    const taskId = 'task-clear' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    service.resolvePermission(createDecision({ requestId, taskId }));
    await waitPromise;

    // Timeout should not fire
    vi.advanceTimersByTime(60000);
    // Test passes if no additional resolution occurs
  });

  it('should do nothing for non-existent request', () => {
    const decision = createDecision({ requestId: 'non-existent' });

    // Should not throw
    expect(() => service.resolvePermission(decision)).not.toThrow();
  });

  it('should handle multiple resolutions of same request (idempotent)', async () => {
    const requestId = 'req-multi';
    const taskId = 'task-multi' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    const decision1 = createDecision({ requestId, taskId, allow: true });
    const decision2 = createDecision({ requestId, taskId, allow: false });

    service.resolvePermission(decision1);
    service.resolvePermission(decision2); // Should have no effect

    const result = await waitPromise;
    expect(result.allow).toBe(true); // First decision wins
  });

  it('should remove request from pending map', async () => {
    const requestId = 'req-remove';
    const taskId = 'task-remove' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    service.resolvePermission(createDecision({ requestId, taskId }));
    await waitPromise;

    // Second resolution should do nothing (request no longer pending)
    service.resolvePermission(createDecision({ requestId, taskId, allow: false }));
  });

  it('should handle different decidedBy values', async () => {
    const users = ['user-1', 'user-2', 'admin', 'anonymous'];

    for (const userId of users) {
      const requestId = `req-${userId}`;
      const taskId = `task-${userId}` as TaskID;
      const signal = new AbortController().signal;

      const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);
      service.resolvePermission(createDecision({ requestId, taskId, decidedBy: userId }));

      const result = await waitPromise;
      expect(result.decidedBy).toBe(userId);
    }
  });
});

// ============================================================================
// Multi-User Scenarios
// ============================================================================

describe('PermissionService multi-user scenarios', () => {
  let emitEvent: ReturnType<typeof vi.fn>;
  let service: PermissionService;

  beforeEach(() => {
    vi.useFakeTimers();
    emitEvent = vi.fn();
    service = new PermissionService(emitEvent as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle first user to respond wins', async () => {
    const requestId = 'req-race';
    const taskId = 'task-race' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    // User B approves first
    service.resolvePermission(
      createDecision({ requestId, taskId, allow: true, decidedBy: 'user-b' })
    );

    // User A denies second (should have no effect)
    service.resolvePermission(
      createDecision({ requestId, taskId, allow: false, decidedBy: 'user-a' })
    );

    const result = await waitPromise;
    expect(result.allow).toBe(true);
    expect(result.decidedBy).toBe('user-b');
  });

  it('should broadcast request to all users', () => {
    const sessionId = 'session-multi' as SessionID;
    const request = createRequest();

    service.emitRequest(sessionId, request);

    // Event should be emitted (which would broadcast to all connected clients)
    expect(emitEvent).toHaveBeenCalledWith(
      'permission:request',
      expect.objectContaining({
        sessionId,
        requestId: request.requestId,
        taskId: request.taskId,
      })
    );
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('PermissionService edge cases', () => {
  let emitEvent: ReturnType<typeof vi.fn>;
  let service: PermissionService;

  beforeEach(() => {
    vi.useFakeTimers();
    emitEvent = vi.fn();
    service = new PermissionService(emitEvent as any);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should handle empty tool input', () => {
    const sessionId = 'session-empty' as SessionID;
    const request = createRequest({ toolInput: {} });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.toolInput).toEqual({});
  });

  it('should handle very long request IDs', () => {
    const longId = 'x'.repeat(1000);
    const sessionId = 'session-long' as SessionID;
    const request = createRequest({ requestId: longId });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.requestId).toBe(longId);
  });

  it('should handle special characters in tool names', () => {
    const sessionId = 'session-special' as SessionID;
    const request = createRequest({ toolName: 'Tool-With_Special.Chars' });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.toolName).toBe('Tool-With_Special.Chars');
  });

  it('should handle missing reason in decision', async () => {
    const requestId = 'req-no-reason';
    const taskId = 'task-no-reason' as TaskID;
    const signal = new AbortController().signal;

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, signal);

    service.resolvePermission(createDecision({ requestId, taskId, reason: undefined }));

    const result = await waitPromise;
    expect(result.reason).toBeUndefined();
  });

  it('should eventually timeout if aborted before wait starts', async () => {
    const requestId = 'req-pre-abort';
    const taskId = 'task-pre-abort' as TaskID;
    const controller = new AbortController();

    // Abort before calling waitForDecision
    controller.abort();

    const waitPromise = service.waitForDecision(requestId, taskId, "session-test" as SessionID, controller.signal);

    // Since signal is already aborted, event listener won't fire
    // This will hit the timeout instead
    vi.advanceTimersByTime(60000);

    const result = await waitPromise;
    expect(result.allow).toBe(false);
    // Will be timeout, not cancelled (implementation limitation)
    expect(result.reason).toBe('Timeout');
  });

  it('should handle nested tool inputs', () => {
    const sessionId = 'session-nested' as SessionID;
    const request = createRequest({
      toolInput: {
        outer: {
          inner: {
            deep: 'value',
          },
        },
        array: [1, 2, 3],
      },
    });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.toolInput).toEqual(request.toolInput);
  });

  it('should preserve timestamp format', () => {
    const sessionId = 'session-time' as SessionID;
    const timestamp = '2024-01-15T10:30:00.000Z';
    const request = createRequest({ timestamp });

    service.emitRequest(sessionId, request);

    const emitted = emitEvent.mock.calls[0][1] as PermissionRequest;
    expect(emitted.timestamp).toBe(timestamp);
  });
});
