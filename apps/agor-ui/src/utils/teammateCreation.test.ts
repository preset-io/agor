import type { Branch, Repo } from '@agor-live/client';
import { describe, expect, it, vi } from 'vitest';
import { createTeammateBranch } from './teammateCreation';

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: 'preset-io/agor-teammate-framework',
    name: 'agor-teammate-framework',
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

describe('createTeammateBranch', () => {
  it('stores teammate identity, including emoji, in the initial branch create payload', async () => {
    const repo = makeRepo();
    const branch = makeBranch({ board_id: 'board-1' });
    const onCreateBranch = vi.fn().mockResolvedValue(branch);
    const boardsService = {
      create: vi.fn().mockResolvedValue({
        board_id: 'board-1',
        name: "Pineapple Helper's Board",
        icon: '🍍',
        objects: {},
      }),
      ensureTeammateWelcomeNote: vi.fn().mockResolvedValue({}),
      setPrimaryTeammate: vi.fn().mockResolvedValue({}),
    };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    };

    await createTeammateBranch(
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
      }
    );

    expect(onCreateBranch).toHaveBeenCalledWith(
      repo.repo_id,
      expect.objectContaining({
        name: 'private-pineapple-helper',
        boardId: 'board-1',
        custom_context: {
          teammate: expect.objectContaining({
            kind: 'teammate',
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
    expect(boardsService.ensureTeammateWelcomeNote).toHaveBeenCalledWith({
      boardId: 'board-1',
      teammateName: 'Pineapple Helper',
      teammateEmoji: '🍍',
    });
    // The branches create hook auto-promotes a new teammate to board primary
    // when the board has none (setPrimaryTeammateIfUnset). Forcing it here would
    // demote an existing primary from ungated create entry points, so the client
    // must NOT call setPrimaryTeammate.
    expect(boardsService.setPrimaryTeammate).not.toHaveBeenCalled();
  });

  it('reuses the provided boardId instead of creating a new board', async () => {
    const repo = makeRepo();
    const branch = makeBranch({ board_id: 'existing-board' });
    const onCreateBranch = vi.fn().mockResolvedValue(branch);
    const boardsService = {
      create: vi.fn(),
      ensureTeammateWelcomeNote: vi.fn().mockResolvedValue({}),
      setPrimaryTeammate: vi.fn().mockResolvedValue({}),
    };
    const client = {
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        throw new Error(`Unexpected service: ${name}`);
      }),
    };

    await createTeammateBranch(
      {
        displayName: 'Board Buddy',
        repoId: repo.repo_id,
        boardId: 'existing-board',
      },
      {
        client: client as never,
        repoById: new Map([[repo.repo_id, repo]]),
        onCreateBranch,
      }
    );

    expect(boardsService.create).not.toHaveBeenCalled();
    expect(onCreateBranch).toHaveBeenCalledWith(
      repo.repo_id,
      expect.objectContaining({ boardId: 'existing-board' })
    );
    // No forcible primary assignment: we rely on the server's create hook to
    // promote the teammate only when the reused board has no primary yet.
    expect(boardsService.setPrimaryTeammate).not.toHaveBeenCalled();
  });
});
