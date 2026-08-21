import type { Branch, Repo, Session } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_REPO_SLUG, findFrameworkRepo } from '../hooks/useFrameworkRepo';
import { ONBOARDING_INTEGRATION_RECOMMENDATIONS } from './onboardingGoals';
import { type SeedOnboardingTeammateInput, seedOnboardingTeammate } from './seedOnboardingTeammate';
import { startTeammateBootstrapSession } from './startTeammateBootstrapSession';
import { createTeammateBranch } from './teammateCreation';

// These are the two collaborators the completion path must actually invoke —
// the original bug meant neither ever ran (the fallback fired instead).
vi.mock('./teammateCreation', () => ({ createTeammateBranch: vi.fn() }));
vi.mock('./startTeammateBootstrapSession', () => ({ startTeammateBootstrapSession: vi.fn() }));

const createTeammateBranchMock = vi.mocked(createTeammateBranch);
const startTeammateBootstrapSessionMock = vi.mocked(startTeammateBootstrapSession);

function setup(overrides: Partial<SeedOnboardingTeammateInput> = {}) {
  const onWarn = vi.fn();
  const onCreateBranch = vi.fn();
  const onUpdateBranch = vi.fn();
  const onCreateSession = vi.fn(async () => 'session-1');
  const client = {
    service: vi.fn((name: string) => {
      if (name === 'branches' || name === 'sessions') {
        return { find: vi.fn(async () => ({ data: [] })) };
      }
      if (name === 'boards') return { setPrimaryTeammate: vi.fn(async () => undefined) };
      return {};
    }),
  } as unknown as SeedOnboardingTeammateInput['client'];
  const input: SeedOnboardingTeammateInput = {
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
  return { input, onWarn, onCreateBranch, onUpdateBranch, onCreateSession };
}

describe('seedOnboardingTeammate', () => {
  beforeEach(() => vi.clearAllMocks());

  it('creates a teammate branch + goal-primed onboarding session when the framework repo is present', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue('session-1');

    const { input, onWarn, onCreateBranch, onUpdateBranch, onCreateSession } = setup();
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
    expect(initialPrompt).toContain('- Suggested tools and connections: Slack, GitHub');
    expect(initialPrompt).toContain('Read ONBOARDING.md');
    expect(initialPrompt).toContain('otherwise, read BOOTSTRAP.md');

    expect(result).toEqual({ branchId: 'branch-1', sessionId: 'session-1' });
    expect(onWarn).not.toHaveBeenCalled();
  });

  // The completion handler (App.handleOnboardingComplete) resolves the framework
  // repo FRESH and READY-ONLY from repoById before calling this. These tests
  // exercise that seam with the repo states real usage actually produces — the
  // daemon pre-creates a `cloning` placeholder, so `frameworkRepo: undefined`
  // never occurs on its own. `findFrameworkRepo(..., { readyOnly: true })` is
  // what turns a not-ready placeholder into the graceful fallback.
  function frameworkRepoWithStatus(clone_status: Repo['clone_status']): Repo {
    return { repo_id: 'repo-fw', slug: FRAMEWORK_REPO_SLUG, clone_status } as Repo;
  }

  for (const status of ['cloning', 'failed'] as const) {
    it(`does NOT create a teammate and warns when the framework repo is ${status} (readyOnly fallback)`, async () => {
      const repoById = new Map<string, Repo>([['repo-fw', frameworkRepoWithStatus(status)]]);
      // Mirror the completion handler: resolve ready-only, feed the result in.
      const readyFrameworkRepo = findFrameworkRepo(repoById, { readyOnly: true })?.[1];
      expect(readyFrameworkRepo).toBeUndefined();

      const { input, onWarn } = setup({ frameworkRepo: readyFrameworkRepo, repoById });
      const result = await seedOnboardingTeammate(input);

      expect(createTeammateBranchMock).not.toHaveBeenCalled();
      expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
      expect(onWarn).toHaveBeenCalledTimes(1);
      expect(onWarn.mock.calls[0][0]).toMatch(/still finishing setup/i);
      expect(result).toEqual({});
    });
  }

  it('creates a teammate when the framework repo is ready (readyOnly resolves it)', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue('session-1');

    const repoById = new Map<string, Repo>([['repo-fw', frameworkRepoWithStatus('ready')]]);
    const readyFrameworkRepo = findFrameworkRepo(repoById, { readyOnly: true })?.[1];
    expect(readyFrameworkRepo?.repo_id).toBe('repo-fw');

    const { input, onWarn } = setup({ frameworkRepo: readyFrameworkRepo, repoById });
    const result = await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).toHaveBeenCalledTimes(1);
    expect(createTeammateBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ repoId: 'repo-fw', createdViaOnboarding: true }),
      expect.anything()
    );
    expect(result).toEqual({ branchId: 'branch-1', sessionId: 'session-1' });
    expect(onWarn).not.toHaveBeenCalled();
  });

  it('threads the template persona and admin MCP agency into the first-session prompt', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue('session-1');

    const { input } = setup({
      goals: [],
      templateId: 'legal-analyst',
      canManageIntegrations: true,
    });
    await seedOnboardingTeammate(input);

    const sessionArg = startTeammateBootstrapSessionMock.mock.calls[0][0];
    const initialPrompt = (sessionArg.sessionConfig as { initialPrompt: string }).initialPrompt;
    // Template persona surfaces in context and drives the personal opener even
    // though no goal was picked.
    expect(initialPrompt).toContain('- Created from the Legal Analyst template.');
    expect(initialPrompt).toMatch(/Open as yourself: one warm line/);
    // Admin gets the "set it up yourself" MCP agency line.
    expect(initialPrompt).toMatch(/offer to set it up for them yourself/i);
  });

  it('forwards the template source branch to createTeammateBranch', async () => {
    createTeammateBranchMock.mockResolvedValue({
      branch_id: 'branch-1',
      board_id: 'board-1',
    } as Branch);
    startTeammateBootstrapSessionMock.mockResolvedValue('session-1');

    const { input } = setup({ sourceBranch: 'template/legal-analyst' });
    await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).toHaveBeenCalledWith(
      expect.objectContaining({ sourceBranch: 'template/legal-analyst' }),
      expect.anything()
    );
  });

  it('warns (non-fatal) and returns no session when teammate creation throws', async () => {
    createTeammateBranchMock.mockRejectedValue(new Error('boom'));
    const { input, onWarn } = setup();

    const result = await seedOnboardingTeammate(input);

    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(onWarn).toHaveBeenCalledTimes(1);
    expect(onWarn.mock.calls[0][0]).toMatch(/couldn't start your AI teammate/i);
    expect(result).toEqual({});
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

      const { input, onWarn, onCreateSession } = setup({ agent });
      const result = await seedOnboardingTeammate(input);

      // The teammate's branch still lands on the board...
      expect(createTeammateBranchMock).toHaveBeenCalledTimes(1);
      // ...but nothing is prompted, and no claude-code default sneaks in.
      expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
      expect(onCreateSession).not.toHaveBeenCalled();
      expect(result).toEqual({ branchId: 'branch-1' });

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
      board_id: 'board-1',
      custom_context: {
        teammate: { kind: 'teammate', createdViaOnboarding: true, displayName: 'Rusty' },
      },
    } as Branch;
    const existingSession = {
      session_id: 'session-existing',
      branch_id: 'branch-existing',
    } as Session;
    const setPrimaryTeammate = vi.fn(async () => undefined);
    const { input, onWarn } = setup({
      frameworkRepo: undefined,
      branchById: new Map([[existingBranch.branch_id, existingBranch]]),
      sessionById: new Map([[existingSession.session_id, existingSession]]),
      client: {
        service: vi.fn(() => ({ setPrimaryTeammate })),
      } as unknown as SeedOnboardingTeammateInput['client'],
    });

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
      board_id: 'board-1',
      custom_context: {
        teammate: { kind: 'teammate', createdViaOnboarding: true, displayName: 'Rusty' },
      },
    } as Branch;
    const existingSession = {
      session_id: 'session-existing',
      branch_id: 'branch-existing',
    } as Session;
    const setPrimaryTeammate = vi.fn(async () => undefined);
    const branchFind = vi.fn(async () => ({ data: [existingBranch] }));
    const sessionFind = vi.fn(async () => ({ data: [existingSession] }));
    const service = vi.fn((name: string) => {
      if (name === 'branches') return { find: branchFind };
      if (name === 'sessions') return { find: sessionFind };
      if (name === 'boards') return { setPrimaryTeammate };
      return {};
    });
    const { input, onWarn } = setup({
      frameworkRepo: undefined,
      branchById: new Map(),
      sessionById: new Map(),
      client: { service } as unknown as SeedOnboardingTeammateInput['client'],
    });

    const result = await seedOnboardingTeammate(input);

    expect(branchFind).toHaveBeenCalledWith({
      query: { board_id: 'board-1', archived: false, $limit: 100 },
    });
    expect(sessionFind).toHaveBeenCalledWith({
      query: { branch_id: 'branch-existing', archived: false, $limit: 1 },
    });
    expect(createTeammateBranchMock).not.toHaveBeenCalled();
    expect(startTeammateBootstrapSessionMock).not.toHaveBeenCalled();
    expect(result).toEqual({
      branchId: 'branch-existing',
      sessionId: 'session-existing',
    });
    expect(onWarn).not.toHaveBeenCalled();
  });
});
