import type { AgorClient, Session } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { createZoneTriggerSession } from './zoneTriggerSessionCreation';

describe('createZoneTriggerSession', () => {
  it.each([[], undefined])('preserves empty versus omitted selection: %j', async (mcpServerIds) => {
    const create = vi.fn(async () => ({ session_id: 'session-1' }) as Session);
    const client = { service: () => ({ create }) } as unknown as AgorClient;
    await createZoneTriggerSession(client, {
      branchId: 'branch-1',
      zoneName: 'Review',
      mcpServerIds,
    });
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ mcpServerIds }));
  });
  it('hands the selected MCP servers to the single session create request', async () => {
    const session = { session_id: 'session-1' } as Session;
    const create = vi.fn(async () => session);
    const service = vi.fn(() => ({ create }));
    const client = { service } as unknown as AgorClient;

    await expect(
      createZoneTriggerSession(client, {
        branchId: 'branch-1',
        zoneName: 'Review',
        agent: 'codex',
        mcpServerIds: ['mcp-1', 'mcp-2'],
      })
    ).resolves.toBe(session);

    expect(service).toHaveBeenCalledTimes(1);
    expect(service).toHaveBeenCalledWith('sessions');
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        branch_id: 'branch-1',
        mcpServerIds: ['mcp-1', 'mcp-2'],
      })
    );
  });
});
