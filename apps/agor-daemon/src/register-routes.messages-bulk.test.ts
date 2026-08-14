import { feathers } from '@agor/core/feathers';
import type { Message } from '@agor/core/types';
import { describe, expect, it, vi } from 'vitest';
import { createMessagesBulkRouteService } from './register-routes.js';
import { registerAuthenticatedRoute } from './utils/authorization.js';

function createAuthenticatedBulkService(createMany: (messages: Message[]) => Promise<Message[]>) {
  const app = feathers();
  registerAuthenticatedRoute(
    app,
    '/messages/bulk',
    createMessagesBulkRouteService({ createMany }),
    { create: { role: 'member', action: 'create messages' } },
    async (context) => context
  );
  return app.service('/messages/bulk') as unknown as {
    create(data: unknown, params: { provider: string; user: { role: 'member' } }): Promise<unknown>;
  };
}

describe('/messages/bulk provider failure boundary', () => {
  it('rejects forged daemon-owned recovery metadata before persistence', async () => {
    const createMany = vi.fn();
    const service = createAuthenticatedBulkService(createMany);

    await expect(
      service.create(
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
        { provider: 'rest', user: { role: 'member' } }
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
    const service = createAuthenticatedBulkService(createMany);

    await expect(
      service.create(messages, { provider: 'rest', user: { role: 'member' } })
    ).resolves.toBe(messages);
    expect(createMany).toHaveBeenCalledWith(messages);
  });
});
