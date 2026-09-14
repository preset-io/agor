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
    const onUpdateBranch = vi.fn();
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
        onUpdateBranch,
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
    expect(boardsService.setPrimaryTeammate).toHaveBeenCalledWith({
      boardId: 'board-1',
      branchId: branch.branch_id,
    });
    expect(onUpdateBranch).not.toHaveBeenCalled();
  });

  it('qualifies a template ref with its source remote while keeping the private repo as destination', async () => {
    const repo = makeRepo({
      slug: 'preset-io/agor-teammate-private',
      remote_url: 'https://github.com/preset-io/agor-teammate-private.git',
    });
    const branch = makeBranch({ board_id: 'board-1' });
    const onCreateBranch = vi.fn().mockResolvedValue(branch);
    const boardsService = {
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
        displayName: 'Deal Desk',
        repoId: repo.repo_id,
        boardId: 'board-1',
        sourceBranch: 'template/deal-desk-revops-analyst',
        sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
        createdViaOnboarding: true,
      },
      {
        client: client as never,
        repoById: new Map([[repo.repo_id, repo]]),
        onCreateBranch,
        onUpdateBranch: vi.fn(),
      }
    );

    expect(onCreateBranch).toHaveBeenCalledWith(
      repo.repo_id,
      expect.objectContaining({
        sourceBranch: 'template/deal-desk-revops-analyst',
        sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
      })
    );
  });
});

describe('manual teammate retry identity', () => {
  it('reuses the exact board and partial branch after a lost create response', async () => {
    const branch = makeBranch({
      board_id: 'attempt-board',
      custom_context: { teammate: { kind: 'teammate' } },
    });
    const boards = {
      create: vi.fn().mockRejectedValue(new Error('Already exists')),
      get: vi.fn(async () => ({ board_id: 'attempt-board' })),
      ensureTeammateWelcomeNote: vi.fn(),
      setPrimaryTeammate: vi.fn(),
    };
    const onCreateBranch = vi.fn();
    const client = {
      service: (name: string) =>
        name === 'boards' ? boards : { find: vi.fn(async () => [branch]) },
    };
    const result = await createTeammateBranch(
      { displayName: 'Ada', repoId: 'repo-1', creationBoardId: 'attempt-board' },
      { client: client as never, repoById: new Map(), onCreateBranch, onUpdateBranch: vi.fn() }
    );
    expect(boards.create).toHaveBeenCalledWith(
      expect.objectContaining({ board_id: 'attempt-board' })
    );
    expect(boards.get).toHaveBeenCalledWith('attempt-board');
    expect(onCreateBranch).not.toHaveBeenCalled();
    expect(result?.branch_id).toBe(branch.branch_id);
  });

  it('does not reuse a partial branch in a changed destination or rewrite its welcome note', async () => {
    const branch = makeBranch({
      board_id: 'attempt-board',
      custom_context: { teammate: { kind: 'teammate' } },
    });
    const boards = {
      create: vi.fn(async () => ({ board_id: 'attempt-board' })),
      ensureTeammateWelcomeNote: vi.fn(),
    };
    const onCreateBranch = vi.fn();
    const client = {
      service: (name: string) =>
        name === 'boards' ? boards : { find: vi.fn(async () => [branch]) },
    };
    await expect(
      createTeammateBranch(
        { displayName: 'Ada', repoId: 'different', creationBoardId: 'attempt-board' },
        { client: client as never, repoById: new Map(), onCreateBranch, onUpdateBranch: vi.fn() }
      )
    ).rejects.toThrow(/another destination/);
    expect(onCreateBranch).not.toHaveBeenCalled();
    expect(boards.ensureTeammateWelcomeNote).not.toHaveBeenCalled();
  });
});
