import type { Branch } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { type BranchEnvironmentAction, requestBranchEnvironmentAction } from './request.js';

describe('requestBranchEnvironmentAction', () => {
  it.each<BranchEnvironmentAction>([
    'start',
    'stop',
    'restart',
  ])('posts %s requests to the public branch environment route', async (action) => {
    const updatedBranch = {
      branch_id: 'branch-123',
      name: 'demo-branch',
    } as unknown as Branch;
    const create = vi.fn(async (_data: Record<string, never>) => updatedBranch);
    const service = vi.fn((path: string) => {
      if (path === 'branches') {
        return {
          create: vi.fn(),
          startEnvironment: vi.fn(),
          stopEnvironment: vi.fn(),
          restartEnvironment: vi.fn(),
        };
      }
      return { create };
    });

    await expect(requestBranchEnvironmentAction({ service }, 'branch-123', action)).resolves.toBe(
      updatedBranch
    );

    expect(service).toHaveBeenCalledWith(`branches/branch-123/${action}`);
    expect(service).not.toHaveBeenCalledWith('branches');
    expect(create).toHaveBeenCalledWith({});
  });

  it('URL-encodes the branch id path segment', async () => {
    const updatedBranch = { branch_id: 'branch/id' } as unknown as Branch;
    const create = vi.fn(async (_data: Record<string, never>) => updatedBranch);
    const service = vi.fn(() => ({ create }));

    await requestBranchEnvironmentAction({ service }, 'branch/id', 'start');

    expect(service).toHaveBeenCalledWith('branches/branch%2Fid/start');
  });
});
