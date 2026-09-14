import type { Branch, Repo, Session, UserID } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ONBOARDING_INTEGRATION_RECOMMENDATIONS } from './onboardingGoals';
import { type SeedOnboardingTeammateInput, seedOnboardingTeammate } from './seedOnboardingTeammate';
import { startTeammateBootstrapSession } from './startTeammateBootstrapSession';
import { createTeammateBranch } from './teammateCreation';

// These are the two collaborators the completion path must actually invoke —
// the original bug meant neither ever ran (the fallback fired instead).
vi.mock('./recoverTeammateFilesystem', () => ({
  recoverTeammateFilesystem: vi.fn(async () => undefined),
}));
vi.mock('./teammateCreation', async (original) => ({
  ...(await original<typeof import('./teammateCreation')>()),
  createTeammateBranch: vi.fn(),
}));
vi.mock('./startTeammateBootstrapSession', () => ({
  startTeammateBootstrapSession: vi.fn(),
  resumeTeammateBootstrapSession: vi.fn(async () => undefined),
}));

const createTeammateBranchMock = vi.mocked(createTeammateBranch);
const startTeammateBootstrapSessionMock = vi.mocked(startTeammateBootstrapSession);

const completeInitialization = {
  sessionId: 'session-1',
};
const USER_ID = 'user-1' as UserID;

function setup(overrides: Partial<SeedOnboardingTeammateInput> = {}) {
  const onWarn = vi.fn();
  const onCreateBranch = vi.fn();
  const onUpdateBranch = vi.fn();
  const onCreateSession = vi.fn(async () => completeInitialization);
  const setPrimaryTeammateIfUnset = vi.fn().mockResolvedValue({ branch_id: 'branch-1' });
  const client = {
    service: vi.fn((name: string) => {
      if (name === 'branches' || name === 'sessions') {
        return { find: vi.fn(async () => ({ data: [] })) };
      }
      if (name === 'boards') return { setPrimaryTeammate: vi.fn(async () => undefined) };
      if (name === 'users') return { setPrimaryTeammateIfUnset };
      return {};
    }),
  } as unknown as SeedOnboardingTeammateInput['client'];
  const input: SeedOnboardingTeammateInput = {
    destinationRepoId: 'repo-fw',
    frameworkRepo: { repo_id: 'repo-fw', slug: 'preset-io/agor-teammate' } as Repo,
    boardId: 'board-1',
    teammateName: 'Rusty',
    teammateEmoji: '🤖',
    agent: 'claude-code',
    suggestedIntegrations: [
      ONBOARDING_INTEGRATION_RECOMMENDATIONS.slack,
      ONBOARDING_INTEGRATION_RECOMMENDATIONS.github,
    ],
    goals: ['ship-without-busywork'],
    user: { name: 'Ada', email: 'ada@example.com' },
    expectedUserId: USER_ID,
    isCurrentUser: () => true,
    client,
    repoById: new Map(),
    branchById: new Map(),
    sessionById: new Map(),
    onCreateBranch,
    onUpdateBranch,
    onCreateSession,
    onWarn,
    ...overrides,
  };
  return {
    input,
    onWarn,
    onCreateBranch,
    onUpdateBranch,
    onCreateSession,
    setPrimaryTeammateIfUnset,
  };
}

describe('seedOnboardingTeammate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a teammate branch + goal-primed onboarding session when the framework repo is present', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue(completeInitialization);

    const {
      input,
      onWarn,
      onCreateBranch,
      onUpdateBranch,
      onCreateSession,
      setPrimaryTeammateIfUnset,
    } = setup();
    const result = await seedOnboardingTeammate(input);

    // Branch is created on the framework repo, reusing the wizard's board.
    expect(createTeammateBranchMock).toHaveBeenCalledTimes(1);
    expect(createTeammateBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        displayName: 'Rusty',
        emoji: '🤖',
        repoId: 'repo-fw',
        boardId: 'board-1',
      }),
      expect.objectContaining({ onCreateBranch, onUpdateBranch })
    );

    // Onboarding session is started for the created branch.
    expect(startTeammateBootstrapSessionMock).toHaveBeenCalledTimes(1);
    const sessionArg = startTeammateBootstrapSessionMock.mock.calls[0][0];
    expect(sessionArg).toEqual(
      expect.objectContaining({ branchId: 'branch-1', boardId: 'board-1', onCreateSession })
    );
    // Agent choice + goals are threaded through to the onboarding prompt.
    expect(sessionArg.sessionConfig).toEqual(
      expect.objectContaining({
        branch_id: 'branch-1',
        agent: 'claude-code',
        title: '🤖 Rusty — first session',
      })
    );
    const initialPrompt = (sessionArg.sessionConfig as { initialPrompt: string }).initialPrompt;
    expect(initialPrompt).toContain('Rusty');
    // The selected goal's bootstrap line is threaded into the first-session prompt.
    expect(initialPrompt).toContain('Desired outcome: less shipping busywork');
    expect(initialPrompt).toContain(
      '- Suggested tools and connections: Slack gateway messaging, GitHub'
    );
    expect(initialPrompt).toContain('Read ONBOARDING.md');
    expect(initialPrompt).toContain('otherwise, read BOOTSTRAP.md');

    expect(result).toEqual({
      branchId: 'branch-1',
      sessionId: 'session-1',
      initialization: completeInitialization,
    });
    expect(setPrimaryTeammateIfUnset).toHaveBeenCalledWith({
      branchId: 'branch-1',
      expectedUserId: USER_ID,
    });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('attaches confirmed Catalog tools without confusing their idle session with the bootstrap', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue(completeInitialization);
    const { input } = setup({
      connectedMcpServerIds: ['server-1'],
      sessionById: new Map([
        [
          'catalog-session',
          { session_id: 'catalog-session', branch_id: 'branch-1', title: 'GitHub' } as Session,
        ],
      ]),
    });
    await seedOnboardingTeammate(input);
    expect(startTeammateBootstrapSessionMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionConfig: expect.objectContaining({
          mcpServerIds: ['server-1'],
          title: '🤖 Rusty — first session',
        }),
      })
    );
  });

  it('returns the durable session after confirmed initialization', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    const incompleteInitialization = {
      sessionId: 'session-1',
    };
    startTeammateBootstrapSessionMock.mockResolvedValue(incompleteInitialization);

    const result = await seedOnboardingTeammate(setup().input);

    expect(result).toEqual({
      branchId: 'branch-1',
      sessionId: 'session-1',
      initialization: incompleteInitialization,
    });
  });

  // Exact-ID readiness is covered in teammateDestination.test.ts. An unresolved
  // destination must not trigger a framework-name fallback in the seed helper.
  function frameworkRepoWithStatus(clone_status: Repo['clone_status']): Repo {
    return { repo_id: 'repo-fw', slug: 'me/memory', clone_status } as Repo;
  }

  for (const status of ['cloning', 'failed'] as const) {
    it(`blocks completion when the chosen destination is ${status}`, async () => {
      const repoById = new Map<string, Repo>([['repo-fw', frameworkRepoWithStatus(status)]]);
      const readyFrameworkRepo = undefined;

      const { input, onWarn } = setup({ frameworkRepo: readyFrameworkRepo, repoById });
      await expect(seedOnboardingTeammate(input)).rejects.toThrow(/not ready/);
      expect(createTeammateBranchMock).not.toHaveBeenCalled();
      expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
      expect(onWarn).not.toHaveBeenCalled();
    });
  }

  it('creates a teammate using the exact ready destination', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue(completeInitialization);

    const repoById = new Map<string, Repo>([['repo-fw', frameworkRepoWithStatus('ready')]]);
    const readyFrameworkRepo = repoById.get('repo-fw');
    expect(readyFrameworkRepo?.repo_id).toBe('repo-fw');

    const { input, onWarn } = setup({ frameworkRepo: readyFrameworkRepo, repoById });
    const result = await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).toHaveBeenCalledTimes(1);
    expect(createTeammateBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-fw', createdViaOnboarding: true }),
      expect.anything()
    );
    expect(result).toEqual({
      branchId: 'branch-1',
      sessionId: 'session-1',
      initialization: completeInitialization,
    });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('threads the template persona and routed integration guidance into the first-session prompt', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue({ sessionId: 'session-1' });

    const { input } = setup({
      goals: [],
      templateId: 'legal-analyst',
    });
    await seedOnboardingTeammate(input);

    const sessionArg = startTeammateBootstrapSessionMock.mock.calls[0][0];
    const initialPrompt = (sessionArg.sessionConfig as { initialPrompt: string }).initialPrompt;
    // Template persona surfaces in context and drives the personal opener even
    // though no goal was picked.
    expect(initialPrompt).toContain('- Created from the Legal Analyst template.');
    expect(initialPrompt).toMatch(/Open as yourself: one warm line/);
    // Slack keeps safe, session-scoped agency while GitHub
    // now points to the reviewed PAT-based Catalog entry.
    expect(initialPrompt).toContain(
      'Slack means gateway messaging here, not an MCP recommendation'
    );
    expect(initialPrompt).toContain('Do not offer generic connector registration');
    expect(initialPrompt).toContain(
      'GitHub: use the reviewed Catalog entry io.github.github/github-mcp-server'
    );
  });

  it('forwards the template source branch to createTeammateBranch', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue(completeInitialization);

    const { input } = setup({
      sourceBranch: 'template/legal-analyst',
      sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
    });
    await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sourceBranch: 'template/legal-analyst',
        sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
      }),
      expect.anything()
    );
  });

  it('rejects completion when teammate creation throws', async () => {
    createTeammateBranchMock.mockRejectedValue(new Error('boom'));
    const { input, onWarn } = setup();

    await expect(seedOnboardingTeammate(input)).rejects.toThrow('boom');
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  // The LLM step is skippable, so `agent` can legitimately be null at completion.
  // Bootstrapping a claude-code session anyway would fail on the first turn with
  // no credentials — the workspace is still created, but the caller gets no
  // session id and therefore lands the user on their board.
  for (const agent of [null, undefined] as const) {
    it(`creates the workspace but no session when the LLM step was skipped (agent: ${agent})`, async () => {
      createTeammateBranchMock.mockResolvedValue({
        branch_id: 'branch-1',
        board_id: 'board-1',
      } as Branch);

      const { input, onWarn, onCreateSession, setPrimaryTeammateIfUnset } = setup({ agent });
      const result = await seedOnboardingTeammate(input);

      // The teammate's branch still lands on the board...
      expect(createTeammateBranchMock).toHaveBeenCalledTimes(1);
      // ...but nothing is prompted, and no claude-code default sneaks in.
      expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
      expect(onCreateSession).not.toHaveBeenCalled();
      expect(result).toEqual({ branchId: 'branch-1' });
      expect(setPrimaryTeammateIfUnset).toHaveBeenCalledWith({
        branchId: 'branch-1',
        expectedUserId: USER_ID,
      });

      // The user is told why there's no session waiting for them.
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onWarn.mock.calls[0][0]).toMatch(/connect an ai model/i);
    });
  }

  it('does nothing when no teammate was named (the workspace step was skipped)', async () => {
    const { input, onWarn } = setup({ teammateName: '   ' });
    const result = await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });

  it('reuses a durable onboarding branch and session on completion retry', async () => {
    const existingBranch = {
      branch_id: 'branch-existing',
      base_ref: 'main',
      board_id: 'board-1',
      repo_id: 'repo-fw',
      custom_context: {
        teammate: {
          kind: 'teammate',
          createdViaOnboarding: true,
          displayName: 'Rusty',
          emoji: '🤖',
        },
      },
    } as unknown as Branch;
    const existingSession = {
      session_id: 'session-existing',
      title: '🤖 Rusty — first session',
      branch_id: 'branch-existing',
    } as unknown as Session;
    const setPrimaryTeammate = vi.fn(async () => undefined);
    const { input: baseInput, onWarn, setPrimaryTeammateIfUnset } = setup();
    const input = {
      ...baseInput,
      frameworkRepo: undefined,
      branchById: new Map([[existingBranch.branch_id, existingBranch]]),
      sessionById: new Map([[existingSession.session_id, existingSession]]),
      client: {
        service: vi.fn((name: string) => {
          if (name === 'boards') return { setPrimaryTeammate };
          if (name === 'users') return { setPrimaryTeammateIfUnset };
          return {};
        }),
      } as unknown as SeedOnboardingTeammateInput['client'],
    } satisfies SeedOnboardingTeammateInput;

    const result = await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(setPrimaryTeammate).toHaveBeenCalledWith({
      boardId: 'board-1',
      branchId: 'branch-existing',
    });
    expect(result).toEqual({
      branchId: 'branch-existing',
      sessionId: 'session-existing',
    });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('discovers durable branch/session state from the API before maps hydrate after reload', async () => {
    const existingBranch = {
      branch_id: 'branch-existing',
      base_ref: 'main',
      board_id: 'board-1',
      repo_id: 'repo-fw',
      custom_context: {
        teammate: {
          kind: 'teammate',
          createdViaOnboarding: true,
          displayName: 'Rusty',
          emoji: '🤖',
        },
      },
    } as unknown as Branch;
    const existingSession = {
      session_id: 'session-existing',
      title: '🤖 Rusty — first session',
      branch_id: 'branch-existing',
    } as unknown as Session;
    const setPrimaryTeammate = vi.fn(async () => undefined);
    const branchFind = vi.fn(async () => ({ data: [existingBranch] }));
    const sessionFind = vi.fn(async () => ({ data: [existingSession] }));
    const service = vi.fn((name: string) => {
      if (name === 'branches') return { find: branchFind };
      if (name === 'sessions') return { find: sessionFind };
      if (name === 'boards') return { setPrimaryTeammate };
      return {};
    });
    const { input: baseInput, onWarn, setPrimaryTeammateIfUnset } = setup();
    const input = {
      ...baseInput,
      frameworkRepo: undefined,
      branchById: new Map(),
      sessionById: new Map(),
      client: {
        service: vi.fn((name: string) => {
          if (name === 'users') return { setPrimaryTeammateIfUnset };
          return service(name);
        }),
      } as unknown as SeedOnboardingTeammateInput['client'],
    } satisfies SeedOnboardingTeammateInput;

    const result = await seedOnboardingTeammate(input);

    expect(branchFind).toHaveBeenCalledWith({
      query: { board_id: 'board-1', archived: false, $limit: 100 },
    });
    expect(sessionFind).toHaveBeenCalledWith({
      query: { branch_id: 'branch-existing', archived: false, $limit: 100 },
    });
    expect(createTeammateBranchMock).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      branchId: 'branch-existing',
      sessionId: 'session-existing',
    });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('refuses a partial teammate in another destination without creating a replacement', async () => {
    const branch = {
      branch_id: 'partial',
      repo_id: 'old-home',
      board_id: 'board-1',
      custom_context: { teammate: { kind: 'teammate', createdViaOnboarding: true } },
    } as unknown as Branch;
    const { input } = setup({
      existingBranchId: 'partial',
      branchById: new Map([['partial', branch]]),
    });
    await expect(seedOnboardingTeammate(input)).rejects.toThrow(/another destination/);
    expect(createTeammateBranchMock).not.toHaveBeenCalled();
  });

  it('retains the branch ID before a failed bootstrap and rejects completion', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'partial',
      board_id: 'board-1',
      repo_id: 'repo-fw',
    } as Branch);
    startTeammateBootstrapSessionMock.mockRejectedValue(new Error('bootstrap failed'));
    const onProgress = vi.fn(async () => undefined);
    await expect(seedOnboardingTeammate(setup({ onProgress }).input)).rejects.toThrow(
      'bootstrap failed'
    );
    expect(onProgress).toHaveBeenCalledWith({ branchId: 'partial' });
  });

  it('rejects a changed persona before re-linking or prompting the retained filesystem', async () => {
    const branch = {
      branch_id: 'partial',
      board_id: 'board-1',
      repo_id: 'repo-fw',
      base_ref: 'template/old',
      base_remote_url: 'https://github.com/preset-io/agor-teammate.git',
      custom_context: { teammate: { kind: 'teammate', createdViaOnboarding: true } },
    } as unknown as Branch;
    const { input } = setup({
      existingBranchId: 'partial',
      branchById: new Map([['partial', branch]]),
      sourceBranch: 'template/new',
      sourceRemoteUrl: branch.base_remote_url,
    });
    await expect(seedOnboardingTeammate(input)).rejects.toThrow('different starter');
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(createTeammateBranchMock).not.toHaveBeenCalled();
  });

  it('does not interpret an unauthorized discovery as absence and create resources', async () => {
    const { input } = setup({
      client: {
        service: () => ({ find: vi.fn().mockRejectedValue(new Error('Forbidden')) }),
      } as never,
    });
    await expect(seedOnboardingTeammate(input)).rejects.toThrow('Forbidden');
    expect(createTeammateBranchMock).not.toHaveBeenCalled();
  });

  it('does not replace a retained session after a forbidden lookup', async () => {
    const branch = {
      branch_id: 'partial',
      base_ref: 'main',
      board_id: 'board-1',
      repo_id: 'repo-fw',
      custom_context: { teammate: { kind: 'teammate', createdViaOnboarding: true } },
    } as unknown as Branch;
    const sessionFind = vi.fn(async () => ({ data: [] }));
    const { input } = setup({
      existingBranchId: 'partial',
      existingSessionId: 'retained-session',
      branchById: new Map([['partial', branch]]),
      client: {
        service: (name: string) => {
          if (name === 'sessions')
            return { get: vi.fn().mockRejectedValue(new Error('Forbidden')), find: sessionFind };
          return {
            setPrimaryTeammate: vi.fn(async () => undefined),
            setPrimaryTeammateIfUnset: vi.fn(async () => undefined),
          };
        },
      } as never,
    });
    await expect(seedOnboardingTeammate(input)).rejects.toThrow('Forbidden');
    expect(sessionFind).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
  });

  it('does not start any onboarding side effect after the initiating user changes', async () => {
    const { input, onWarn, setPrimaryTeammateIfUnset } = setup({
      isCurrentUser: () => false,
    });

    await expect(seedOnboardingTeammate(input)).resolves.toEqual({});

    expect(createTeammateBranchMock).not.toHaveBeenCalled();
    expect(setPrimaryTeammateIfUnset).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('stops after a delayed branch stage when the initiating user changes', async () => {
    let currentUserId = USER_ID;
    let resolveBranch!: (branch: Branch) => void;
    createTeammateBranchMock.mockImplementation(
      () =>
        new Promise<Branch>((resolve) => {
          resolveBranch = resolve;
        })
    );
    const { input, onWarn, setPrimaryTeammateIfUnset } = setup({
      isCurrentUser: (expectedUserId) => currentUserId === expectedUserId,
    });

    const seeding = seedOnboardingTeammate(input);
    await vi.waitFor(() => expect(createTeammateBranchMock).toHaveBeenCalledTimes(1));
    currentUserId = 'user-2' as UserID;
    resolveBranch({ branch_id: 'branch-1', board_id: 'board-1' } as Branch);

    await expect(seeding).resolves.toEqual({});
    expect(setPrimaryTeammateIfUnset).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('stops after a delayed stage when the same user establishes a new auth session', async () => {
    let authenticationGeneration = 1;
    const operationGeneration = authenticationGeneration;
    let resolveBranch!: (branch: Branch) => void;
    createTeammateBranchMock.mockImplementation(
      () =>
        new Promise<Branch>((resolve) => {
          resolveBranch = resolve;
        })
    );
    const { input, onWarn, setPrimaryTeammateIfUnset } = setup({
      isCurrentUser: (expectedUserId) =>
        expectedUserId === USER_ID && authenticationGeneration === operationGeneration,
    });

    const seeding = seedOnboardingTeammate(input);
    await vi.waitFor(() => expect(createTeammateBranchMock).toHaveBeenCalledTimes(1));
    authenticationGeneration += 1;
    resolveBranch({ branch_id: 'branch-1', board_id: 'board-1' } as Branch);

    await expect(seeding).resolves.toEqual({});
    expect(setPrimaryTeammateIfUnset).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
  });
});
