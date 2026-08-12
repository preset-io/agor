import type { Message } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createMessagesBulkRouteService } from './register-routes.js';

describe('/messages/bulk provider failure boundary', () => {
  it('rejects forged daemon-owned recovery metadata before persistence', async () => {
    const createMany = vi.fn();
    const route = createMessagesBulkRouteService({ createMany } as never);

    await expect(
      route.create(
        [
          {
            type: 'system',
            role: 'system',
            metadata: {
              error_kind: 'provider_credit_exhausted',
              tool: 'claude-code',
            },
          },
        ],
        {} as never
      )
    ).rejects.toThrow('Provider failure metadata can only be classified by the daemon');
    expect(createMany).not.toHaveBeenCalled();
  });

  it('passes ordinary executor-scoped messages to the scoped service dependency', async () => {
    const messages = [
      {
        task_id: 'task-1',
        session_id: 'session-1',
        metadata: { is_provider_failure_result: true },
      },
    ] as unknown as Message[];
    const createMany = vi.fn().mockResolvedValue(messages);
    const route = createMessagesBulkRouteService({ createMany } as never);

    await expect(route.create(messages, {} as never)).resolves.toBe(messages);
    expect(createMany).toHaveBeenCalledWith(messages);
  });
});
