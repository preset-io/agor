import type { AgorClient, BranchID } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { createZoneTriggerSession } from './SessionCanvas';

function makeClient() {
  const create = vi.fn(async (data) => ({ session_id: 'session-1', ...data }));
  const client = {
    service: vi.fn(() => ({ create })),
  } as unknown as AgorClient;
  return { client, create };
}

describe('createZoneTriggerSession OpenCode model config', () => {
  it('submits an absent override as omission for daemon fallback resolution', async () => {
    const { client, create } = makeClient();

    await createZoneTriggerSession(client, {
      branchId: 'branch-1' as BranchID,
      zoneName: 'Review',
      agent: 'opencode',
      modelConfig: undefined,
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
      })
    );
    expect(create.mock.calls[0][0]).not.toHaveProperty('model_config');
  });

  it('submits a complete exact pair without changing it', async () => {
    const { client, create } = makeClient();

    await createZoneTriggerSession(client, {
      branchId: 'branch-1' as BranchID,
      zoneName: 'Review',
      agent: 'opencode',
      modelConfig: { mode: 'exact', provider: 'openai', model: 'gpt-5' },
    });

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        agentic_tool: 'opencode',
        model_config: {
          mode: 'exact',
          provider: 'openai',
          model: 'gpt-5',
          updated_at: expect.any(String),
        },
      })
    );
  });
});
