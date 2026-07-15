import type { Branch, Repo } from '@agor-live/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FRAMEWORK_REPO_SLUG, findFrameworkRepo } from '../hooks/useFrameworkRepo';
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
  const input: SeedOnboardingTeammateInput = {
    frameworkRepo: { repo_id: 'repo-fw', slug: 'preset-io/agor-teammate' } as Repo,
    boardId: 'board-1',
    teammateName: 'Rusty',
    teammateEmoji: '🤖',
    agent: 'claude-code',
    suggestedIntegrations: ['Slack', 'GitHub'],
    user: { name: 'Ada', email: 'ada@example.com', persona: 'developer' },
    client: {} as SeedOnboardingTeammateInput['client'],
    repoById: new Map(),
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

  it('creates a teammate branch + persona-primed bootstrap session when the framework repo is present', async () => {
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

    // Bootstrap session is started for the created branch.
    expect(startTeammateBootstrapSessionMock).toHaveBeenCalledTimes(1);
    const sessionArg = startTeammateBootstrapSessionMock.mock.calls[0][0];
    expect(sessionArg).toEqual(
      expect.objectContaining({ branchId: 'branch-1', boardId: 'board-1', onCreateSession })
    );
    // Agent choice + persona are threaded through to the bootstrap prompt.
    expect(sessionArg.sessionConfig).toEqual(
      expect.objectContaining({ branch_id: 'branch-1', agent: 'claude-code' })
    );
    const initialPrompt = (sessionArg.sessionConfig as { initialPrompt: string }).initialPrompt;
    expect(initialPrompt).toContain('Rusty');
    expect(initialPrompt).toContain('developer');
    expect(initialPrompt).toContain('- Suggested integrations: Slack, GitHub');

    expect(result).toEqual({ sessionId: 'session-1' });
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
    expect(result).toEqual({ sessionId: 'session-1' });
    expect(onWarn).not.toHaveBeenCalled();
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

  it('does nothing when no teammate was named (the workspace step was skipped)', async () => {
    const { input, onWarn } = setup({ teammateName: '   ' });
    const result = await seedOnboardingTeammate(input);

    expect(createTeammateBranchMock).not.toHaveBeenCalled();
    expect(onWarn).not.toHaveBeenCalled();
    expect(result).toEqual({});
  });
});
