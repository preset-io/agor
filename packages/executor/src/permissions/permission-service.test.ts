import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgorClient } from '../services/feathers-client.js';
import { createExecutionPermissionService, PermissionService } from './permission-service.js';

describe('PermissionService interaction capability', () => {
  const taskId = 'task-1' as TaskID;
  const sessionId = 'session-1' as SessionID;

  afterEach(() => vi.useRealTimers());

  it('fails immediately when the launch surface cannot answer', async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const service = new PermissionService(emitEvent, 600_000, 'unattended');

    await expect(
      service.waitForDecision('request-1', taskId, sessionId, new AbortController().signal)
    ).resolves.toMatchObject({
      outcome: 'unavailable',
      decidedBy: 'system',
    });
  });

  it('does not wait when cancellation arrived before registration', async () => {
    const service = new PermissionService(vi.fn().mockResolvedValue(undefined));
    const abortController = new AbortController();
    abortController.abort();

    await expect(
      service.waitForDecision('request-1', taskId, sessionId, abortController.signal)
    ).resolves.toMatchObject({
      outcome: 'cancelled',
      reason: 'Cancelled',
      decidedBy: 'system',
    });
  });

  it('normalizes an interactive decision without carrying the transport boolean', async () => {
    const service = new PermissionService(vi.fn().mockResolvedValue(undefined));
    const resolution = service.waitForDecision(
      'request-1',
      taskId,
      sessionId,
      new AbortController().signal
    );

    service.resolvePermission({
      requestId: 'request-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });

    await expect(resolution).resolves.toMatchObject({
      outcome: 'approved',
      decidedBy: 'test-user',
    });
    await expect(resolution).resolves.not.toHaveProperty('allow');
  });

  it('returns a typed timeout result and emits the timeout event', async () => {
    vi.useFakeTimers();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const service = new PermissionService(emitEvent, 1);
    const resolution = service.waitForDecision(
      'request-1',
      taskId,
      sessionId,
      new AbortController().signal
    );

    await vi.advanceTimersByTimeAsync(1);

    await expect(resolution).resolves.toMatchObject({
      outcome: 'timed_out',
      decidedBy: 'system',
    });
    expect(emitEvent).toHaveBeenCalledWith('permission:timeout', {
      requestId: 'request-1',
      sessionId,
      taskId,
    });
  });

  it.each([
    [undefined, 600_000],
    [{ execution: { permission_timeout_ms: 42_000 } }, 42_000],
  ] as const)(
    'reports an identified permission wait using the resolved %s timeout',
    async (resolvedConfig, expectedTimeoutMs) => {
      const emit = vi.fn();
      const onActivity = vi.fn();
      const client = {
        service: vi.fn(() => ({ emit })),
      } as unknown as AgorClient;
      const service = createExecutionPermissionService({ client, onActivity, resolvedConfig });

      await service.emitRequest(sessionId, {
        requestId: 'request-1',
        taskId,
        toolName: 'Bash',
        toolInput: {},
        timestamp: new Date().toISOString(),
      });

      const resolution = service.waitForDecision(
        'request-1',
        taskId,
        sessionId,
        new AbortController().signal
      );
      expect(onActivity).toHaveBeenCalledWith({
        type: 'waiting_started',
        id: 'request-1',
        reason: 'permission',
        absoluteTimeoutMs: expectedTimeoutMs,
      });
      service.resolvePermission({
        requestId: 'request-1',
        taskId,
        allow: true,
        remember: false,
        scope: PermissionScope.ONCE,
        decidedBy: 'user-1',
      });
      await expect(resolution).resolves.toMatchObject({ outcome: 'approved' });
      expect(onActivity).toHaveBeenLastCalledWith({
        type: 'waiting_finished',
        id: 'request-1',
        outcome: 'approved',
      });
      expect(emit).toHaveBeenCalledWith(
        'permission:request',
        expect.objectContaining({ requestId: 'request-1', sessionId, taskId })
      );
    }
  );
});
