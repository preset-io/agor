import type { SessionID, TaskID } from '@agor/core/types';
import { ExecutorPulseKind, PermissionScope } from '@agor/core/types';
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

  it('maps permission request emission to the shared waiting pulse', async () => {
    const emit = vi.fn();
    const onPulse = vi.fn();
    const client = {
      service: vi.fn(() => ({ emit })),
    } as unknown as AgorClient;
    const service = createExecutionPermissionService({ client, onPulse });

    await service.emitRequest(sessionId, {
      requestId: 'request-1',
      taskId,
      toolName: 'Bash',
      toolInput: {},
      timestamp: new Date().toISOString(),
    });

    expect(onPulse).toHaveBeenCalledWith(ExecutorPulseKind.WAITING, 'permission.request');
    expect(emit).toHaveBeenCalledWith(
      'permission:request',
      expect.objectContaining({ requestId: 'request-1', sessionId, taskId })
    );
  });
});
