import type { AgorClient, User } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { setPrimaryAgenticToolIfUnset } from './primaryAgenticTool';

describe('setPrimaryAgenticToolIfUnset', () => {
  it('delegates unset bootstrapping to the atomic user RPC', async () => {
    const setIfUnset = vi.fn(async () => ({ primary_agentic_tool: 'codex' }) as User);
    const client = {
      service: () => ({ setPrimaryAgenticToolIfUnset: setIfUnset }),
    } as unknown as AgorClient;
    const user = { user_id: 'user-1' } as User;

    await expect(setPrimaryAgenticToolIfUnset(client, user, 'codex')).resolves.toMatchObject({
      primary_agentic_tool: 'codex',
    });
    expect(setIfUnset).toHaveBeenCalledWith({ tool: 'codex' });
  });

  it('does not rewrite an existing Settings preference', async () => {
    const setIfUnset = vi.fn();
    const client = {
      service: () => ({ setPrimaryAgenticToolIfUnset: setIfUnset }),
    } as unknown as AgorClient;
    const user = { user_id: 'user-1', primary_agentic_tool: 'gemini' } as User;

    await expect(setPrimaryAgenticToolIfUnset(client, user, 'codex')).resolves.toBe(user);
    expect(setIfUnset).not.toHaveBeenCalled();
  });
});
