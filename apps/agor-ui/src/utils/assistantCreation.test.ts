import type { Branch, Repo } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { createAssistantBranch } from './assistantCreation';

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'preset-io/agor-assistant-framework',
    name: 'agor-assistant-framework',
    default_branch: 'main',
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:00.000Z',
    ...overrides,
  } as Repo;
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    repo_id: 'repo-1',
    name: 'private-pineapple',
    ref: 'private-pineapple',
    path: '/tmp/private-pineapple',
    created_at: '2026-05-26T00:00:00.000Z',
    updated_at: '2026-05-26T00:00:00.000Z',
    sessions: [],
    ...overrides,
  } as Branch;
}

describe('createAssistantBranch', () => {
  it('stores assistant identity, including emoji, in the initial branch create payload', async () => {
    const repo = makeRepo();
    const branch = makeBranch({ board_id: 'board-1' });
    const onCreateBranch = vi.fn().mockResolvedValue(branch);
    const onUpdateBranch = vi.fn();
    const boardsService = {
      create: vi.fn().mockResolvedValue({
        board_id: 'board-1',
        name: "Pineapple Helper's Board",
        icon: '🍍',
        objects: {},
      }),
      get: vi.fn().mockResolvedValue({ board_id: 'board-1', objects: {} }),
      patch: vi.fn().mockResolvedValue({}),
      setPrimaryAssistant: vi.fn().mockResolvedValue({}),
    };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    };

    await createAssistantBranch(
      {
        displayName: 'Pineapple Helper',
        emoji: '🍍',
        description: 'Helps with pineapple tasks.',
        repoId: repo.repo_id,
      },
      {
        client: client as never,
        repoById: new Map([[repo.repo_id, repo]]),
        onCreateBranch,
        onUpdateBranch,
      }
    );

    expect(onCreateBranch).toHaveBeenCalledWith(
      repo.repo_id,
      expect.objectContaining({
        name: 'private-pineapple-helper',
        boardId: 'board-1',
        custom_context: {
          assistant: expect.objectContaining({
            kind: 'assistant',
            displayName: 'Pineapple Helper',
            emoji: '🍍',
          }),
        },
        notes: 'Helps with pineapple tasks.',
      })
    );
    expect(boardsService.create).toHaveBeenCalledWith({
      name: "Pineapple Helper's Board",
      icon: '🍍',
    });
    expect(boardsService.patch).toHaveBeenCalledWith(
      'board-1',
      expect.objectContaining({
        _action: 'upsertObject',
        objectId: 'welcome-note',
      })
    );
    expect(boardsService.setPrimaryAssistant).toHaveBeenCalledWith({
      boardId: 'board-1',
      branchId: branch.branch_id,
    });
    expect(onUpdateBranch).not.toHaveBeenCalled();
  });
});
