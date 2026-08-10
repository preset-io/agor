import type { ResolvedSdkWatchdogConfig } from '@agor/core/config';
import type { SessionID, TaskID } from '@agor/core/types';
import { PermissionScope } from '@agor/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SdkWatchdog } from '../sdk-watchdog.js';
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

  it('rejects unattended interaction before any event or watchdog activity', async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();
    const service = new PermissionService(emitEvent, 600_000, 'unattended', onActivity);

    await expect(
      service.acquireInteraction(sessionId, new AbortController().signal)
    ).rejects.toThrow(/cannot answer permission requests/i);

    expect(emitEvent).not.toHaveBeenCalled();
    expect(onActivity).not.toHaveBeenCalled();
  });

  it('serializes three interactions per Session in arrival order', async () => {
    const service = new PermissionService(vi.fn().mockResolvedValue(undefined));
    const releases: Array<() => void> = [];
    const order: string[] = [];
    const run = async (label: string) => {
      const releaseInteraction = await service.acquireInteraction(
        sessionId,
        new AbortController().signal
      );
      try {
        order.push(`start:${label}`);
        await new Promise<void>((resolve) => releases.push(resolve));
        order.push(`finish:${label}`);
        return label;
      } finally {
        releaseInteraction();
      }
    };

    const first = run('first');
    const second = run('second');
    const third = run('third');
    await vi.waitFor(() => expect(order).toEqual(['start:first']));

    releases.shift()?.();
    await vi.waitFor(() => expect(order).toEqual(['start:first', 'finish:first', 'start:second']));
    releases.shift()?.();
    await vi.waitFor(() =>
      expect(order).toEqual([
        'start:first',
        'finish:first',
        'start:second',
        'finish:second',
        'start:third',
      ])
    );
    releases.shift()?.();

    await expect(Promise.all([first, second, third])).resolves.toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('revalidates cancellation after waiting for the Session tail', async () => {
    const service = new PermissionService(vi.fn().mockResolvedValue(undefined));
    const releaseFirst = await service.acquireInteraction(sessionId, new AbortController().signal);
    const queuedAbort = new AbortController();
    const second = service.acquireInteraction(sessionId, queuedAbort.signal);
    queuedAbort.abort();
    releaseFirst();

    await expect(second).rejects.toThrow(/cancelled/i);
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
    ['approved', true],
    ['denied', false],
  ] as const)('settles %s exactly once when abort races a decision', async (outcome, allow) => {
    const onActivity = vi.fn();
    const service = new PermissionService(
      vi.fn().mockResolvedValue(undefined),
      600_000,
      'interactive',
      onActivity
    );
    const abortController = new AbortController();
    const resolution = service.waitForDecision(
      'request-1',
      taskId,
      sessionId,
      abortController.signal
    );

    service.resolvePermission({
      requestId: 'request-1',
      taskId,
      allow,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });
    abortController.abort();

    await expect(resolution).resolves.toMatchObject({ outcome });
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(onActivity).toHaveBeenLastCalledWith({
      type: 'waiting_finished',
      id: 'request-1',
      outcome,
    });
  });

  it('does not turn an ordinary denial/abort race into adapter incompatibility', async () => {
    const decisions: unknown[] = [];
    const watchdog = new SdkWatchdog({
      tool: 'claude-code',
      config: {
        mode: 'enforce',
        first_progress_timeout_ms: 60_000,
        operation_absolute_timeout_ms: 60_000,
        abort_grace_ms: 100,
        claude_idle_timeout_ms: 60_000,
        codex_idle_timeout_ms: 60_000,
      } as ResolvedSdkWatchdogConfig,
      onDecision: (evidence) => {
        decisions.push(evidence);
      },
    });
    const service = new PermissionService(
      vi.fn().mockResolvedValue(undefined),
      600_000,
      'interactive',
      (activity) => watchdog.record(activity)
    );
    const abortController = new AbortController();
    const resolution = service.waitForDecision(
      'request-1',
      taskId,
      sessionId,
      abortController.signal
    );

    service.resolvePermission({
      requestId: 'request-1',
      taskId,
      allow: false,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });
    abortController.abort();

    await expect(resolution).resolves.toMatchObject({ outcome: 'denied' });
    expect(decisions).toEqual([]);
  });

  it('settles timeout exactly once when abort and a late decision follow', async () => {
    vi.useFakeTimers();
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const onActivity = vi.fn();
    const service = new PermissionService(emitEvent, 1, 'interactive', onActivity);
    const abortController = new AbortController();
    const resolution = service.waitForDecision(
      'request-1',
      taskId,
      sessionId,
      abortController.signal
    );

    await vi.advanceTimersByTimeAsync(1);
    abortController.abort();
    service.resolvePermission({
      requestId: 'request-1',
      taskId,
      allow: true,
      remember: false,
      scope: PermissionScope.ONCE,
      decidedBy: 'test-user',
    });

    await expect(resolution).resolves.toMatchObject({ outcome: 'timed_out' });
    expect(onActivity).toHaveBeenCalledTimes(2);
    expect(emitEvent).toHaveBeenCalledTimes(1);
  });

  it('settles cancellation exactly once for every pending request in a session', async () => {
    const onActivity = vi.fn();
    const service = new PermissionService(
      vi.fn().mockResolvedValue(undefined),
      600_000,
      'interactive',
      onActivity
    );
    const abortController = new AbortController();
    const resolution = service.waitForDecision(
      'request-1',
      taskId,
      sessionId,
      abortController.signal
    );

    service.cancelPendingRequests(sessionId);
    abortController.abort();

    await expect(resolution).resolves.toMatchObject({ outcome: 'cancelled', taskId });
    expect(onActivity).toHaveBeenCalledTimes(2);
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
        deadlineOwner: 'adapter',
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
