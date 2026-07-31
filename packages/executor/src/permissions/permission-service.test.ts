import type { SessionID, TaskID } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { PermissionService } from './permission-service.js';

describe('PermissionService interaction capability', () => {
  const taskId = 'task-1' as TaskID;
  const sessionId = 'session-1' as SessionID;

  it('fails immediately when the launch surface cannot answer', async () => {
    const emitEvent = vi.fn().mockResolvedValue(undefined);
    const service = new PermissionService(emitEvent, 600_000, 'unattended');

    await expect(
      service.waitForDecision('request-1', taskId, sessionId, new AbortController().signal)
    ).resolves.toMatchObject({
      allow: false,
      unavailable: true,
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
      allow: false,
      reason: 'Cancelled',
      decidedBy: 'system',
    });
  });
});
