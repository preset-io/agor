import type { Board, Branch, Repo, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { FRAMEWORK_REPO_SLUG } from '../../hooks/useFrameworkRepo';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { OnboardingWizard } from './OnboardingWizard';

vi.mock('../EmojiPickerInput/EmojiPickerInput', () => ({
  EmojiPickerInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange(value)} aria-label="emoji picker">
      {value}
    </button>
  ),
}));

vi.mock('../../utils/startTeammateBootstrapSession', () => {
  const start = vi.fn(async ({ onCreateSession, sessionConfig, boardId }) => {
    return (await onCreateSession(sessionConfig, boardId)) || 'session-1';
  });
  return { startTeammateBootstrapSession: start };
});

vi.mock('../../utils/teammateWelcomeNote', () => {
  const ensure = vi.fn(async () => undefined);
  return { ensureTeammateWelcomeNote: ensure };
});

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'new-user@example.com',
    name: 'New User',
    role: 'member',
    onboarding_completed: false,
    preferences: {},
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...overrides,
  } as unknown as User;
}

function makeRepo(overrides: Partial<Repo> = {}): Repo {
  return {
    repo_id: 'repo-1',
    slug: FRAMEWORK_REPO_SLUG,
    remote_url: 'https://github.com/preset-io/agor-teammate.git',
    clone_status: 'ready',
    default_branch: 'main',
    ...overrides,
  } as Repo;
}

function makeBranch(overrides: Partial<Branch> = {}): Branch {
  return {
    branch_id: 'branch-1',
    repo_id: 'repo-1',
    name: 'private-my-teammate',
    ref: 'private-my-teammate',
    created_by: 'user-1',
    ...overrides,
  } as Branch;
}

// The wizard now self-subscribes to repoById / branchById / boardById from the
// store instead of receiving them as props, so the harness seeds those slices
// into the store rather than passing them through. Map seeds may be supplied
// alongside the component-prop overrides; they're split out here.
function renderWizard(
  overrides: Partial<ComponentProps<typeof OnboardingWizard>> & {
    repoById?: Map<string, Repo>;
    branchById?: Map<string, Branch>;
    boardById?: Map<string, Board>;
  } = {}
) {
  const { repoById, branchById, boardById, ...componentOverrides } = overrides;
  agorStore.setState({
    ...EMPTY_MAPS,
    ...(repoById ? { repoById } : {}),
    ...(branchById ? { branchById } : {}),
    ...(boardById ? { boardById } : {}),
  });

  const boardsService = {
    create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
    setPrimaryTeammate: vi.fn(async () => undefined),
    ensureTeammateWelcomeNote: vi.fn(async () => undefined),
  };
  const reposService = {
    find: vi.fn(async () => ({ data: [] })),
    get: vi.fn(async () => undefined),
    on: vi.fn(),
    removeListener: vi.fn(),
  };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => (name === 'boards' ? boardsService : reposService)),
  };
  const props = {
    open: true,
    onComplete: vi.fn(),
    user: makeUser(),
    client,
    onCreateRepo: vi.fn(async () => undefined),
    onCreateLocalRepo: vi.fn(),
    onCreateBranch: vi.fn(async () => makeBranch()),
    onCreateSession: vi.fn(async () => 'session-1'),
    onUpdateUser: vi.fn(async () => undefined),
    ...componentOverrides,
  } satisfies ComponentProps<typeof OnboardingWizard>;

  return { ...render(<OnboardingWizard {...props} />), props, client, boardsService };
}

describe('OnboardingWizard', () => {
  it('starts on teammate name and emoji only, then advances to LLM setup', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ onUpdateUser });

    expect(screen.getByText(/Welcome to Agor/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Agor AI teammate/i })).toHaveAttribute(
      'href',
      'https://agor.live/guide/teammates'
    );
    expect(screen.getByText('Your AI teammate can help:')).toBeInTheDocument();
    expect(screen.getByText(/Connect tools and credentials/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /emoji picker/i })).toBeInTheDocument();
    expect(screen.getByDisplayValue('My Teammate')).toBeInTheDocument();
    expect(screen.queryByText(/Add Your Repository/i)).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/Branch name/i)).not.toBeInTheDocument();

    fireEvent.change(screen.getByDisplayValue('My Teammate'), { target: { value: 'Scout' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText(/Choose your LLM/i)).toBeInTheDocument();
    expect(screen.getByText(/Step 2 of 2/i)).toBeInTheDocument();
    expect(onUpdateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        preferences: expect.objectContaining({
          onboarding: expect.objectContaining({
            path: 'teammate',
            teammateDisplayName: 'Scout',
            teammateEmoji: '🤖',
          }),
        }),
      })
    );
  });

  it('hydrates teammate identity from legacy assistant onboarding preferences', () => {
    renderWizard({
      user: makeUser({
        preferences: {
          onboarding: {
            assistantDisplayName: 'Legacy Scout',
            assistantEmoji: '🛰️',
          },
        },
      } as Partial<User>),
    });

    expect(screen.getByDisplayValue('Legacy Scout')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /emoji picker/i })).toHaveTextContent('🛰️');
  });

  it('can skip setup after confirmation', async () => {
    const onComplete = vi.fn();
    const onCreateRepo = vi.fn(async () => undefined);
    renderWizard({ onComplete, onCreateRepo });

    fireEvent.click(screen.getByRole('button', { name: /skip setup/i }));
    fireEvent.click(await screen.findByRole('button', { name: /skip anyway/i }));

    expect(onComplete).toHaveBeenCalledWith({
      branchId: '',
      sessionId: '',
      boardId: '',
      path: 'teammate',
    });
    expect(onCreateRepo).not.toHaveBeenCalled();
  });

  it('keeps onboarding open when skip confirmation is cancelled', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete });

    fireEvent.click(screen.getByRole('button', { name: /skip setup/i }));
    fireEvent.click(await screen.findByRole('button', { name: /go back/i }));

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText(/Welcome to Agor/i)).toBeInTheDocument();
  });

  it('shows recommended provider cards plus a secondary selector', async () => {
    const { baseElement } = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText('Choose your LLM')).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByAltText('claude-code logo')).toBeInTheDocument();
    expect(screen.getByAltText('codex logo')).toBeInTheDocument();
    const providerOptions = Array.from(
      baseElement.querySelectorAll<HTMLInputElement>('input[name="recommended-agent"]')
    );
    const claudeOption = providerOptions.find((option) => option.value === 'claude-code');
    const codexOption = providerOptions.find((option) => option.value === 'codex');
    expect(claudeOption).toBeChecked();
    expect(baseElement.querySelector('input[value="claude-subscription-token"]')).toBeChecked();
    expect(screen.getByText(/claude setup-token/)).toBeInTheDocument();
    expect(screen.getByText(/terminal with Claude Code installed/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /install docs/i })).toHaveAttribute(
      'href',
      'https://docs.claude.com/en/docs/claude-code/setup'
    );

    fireEvent.click(screen.getByText('API key'));
    expect(baseElement.querySelector('input[value="api-key"]')).toBeChecked();
    expect(screen.getAllByText(/ANTHROPIC_API_KEY/).length).toBeGreaterThan(0);

    fireEvent.click(codexOption as HTMLInputElement);
    expect(codexOption).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /use a different provider/i })).toBeInTheDocument();
    expect(screen.queryByText('Other LLM providers')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /use a different provider/i }));
    expect(screen.getByText('Other LLM providers')).toBeInTheDocument();
  });

  it('can save a Claude subscription token during onboarding', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ onUpdateUser });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByText('Subscription'));
    fireEvent.change(screen.getByPlaceholderText('sk-ant-oat01-...'), {
      target: { value: 'sk-ant-oat01-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          agentic_tools: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
          },
        })
      );
    });
  });

  it('uses one bounded modal body for input and loading steps', async () => {
    renderWizard();
    const body = document.querySelector('.ant-modal-body') as HTMLElement;
    expect(body).toHaveStyle({ minHeight: '440px', maxHeight: '640px', overflowY: 'auto' });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    expect(document.querySelector('.ant-modal-body')).toBe(body);
    expect(body).toHaveStyle({ minHeight: '440px', maxHeight: '640px', overflowY: 'auto' });

    fireEvent.click(await screen.findByRole('button', { name: /continue without key/i }));
    expect(await screen.findByText(/Setting up Agor/i)).toBeInTheDocument();
    expect(screen.getByText(/Cloning AI teammate framework/i)).toBeInTheDocument();
    expect(document.querySelector('.ant-modal-body')).toBe(body);
    expect(body).toHaveStyle({ minHeight: '440px', maxHeight: '640px', overflowY: 'auto' });
  });

  it('ignores stale failed framework repo rows when retrying setup', async () => {
    const repoById = new Map<string, Repo>([
      [
        'failed-old',
        makeRepo({
          repo_id: 'failed-old',
          clone_status: 'failed',
          clone_error: { message: 'old failure', exit_code: 1 },
        }),
      ],
    ]);
    const onCreateRepo = vi.fn(async () => undefined);
    renderWizard({ repoById, onCreateRepo });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /continue without key/i }));

    await waitFor(() => expect(onCreateRepo).toHaveBeenCalled());
    expect(screen.getByText(/Cloning AI teammate framework/i)).toBeInTheDocument();
    expect(screen.queryByText(/Setup failed/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/old failure/i)).not.toBeInTheDocument();

    const nextRepoById = new Map(repoById);
    nextRepoById.set(
      'failed-new',
      makeRepo({
        repo_id: 'failed-new',
        clone_status: 'failed',
        clone_error: { message: 'new failure', exit_code: 1 },
      })
    );
    act(() => {
      agorStore.setState({ repoById: nextRepoById });
    });

    expect(await screen.findByText(/Setup failed/i)).toBeInTheDocument();
    expect(screen.getByText(/new failure/i)).toBeInTheDocument();
  });

  it('continues when clone returns an existing ready framework repo not yet in local state', async () => {
    const readyRepo = makeRepo({ repo_id: 'repo-existing' });
    const reposService = {
      get: vi.fn(async () => readyRepo),
      find: vi.fn(async () => ({ data: [readyRepo] })),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const boardsService = {
      create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
      setPrimaryTeammate: vi.fn(async () => undefined),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'repos') return reposService;
        return { find: vi.fn(async () => ({ data: [] })) };
      }),
    };
    const onCreateRepo = vi.fn(async () => ({
      status: 'exists' as const,
      slug: FRAMEWORK_REPO_SLUG,
      repo_id: 'repo-existing',
    }));
    const onCreateBranch = vi.fn(async () => makeBranch({ repo_id: 'repo-existing' }));

    renderWizard({ client, onCreateRepo, onCreateBranch });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /continue without key/i }));

    await waitFor(() =>
      expect(onCreateRepo).toHaveBeenCalledWith(
        expect.objectContaining({ slug: FRAMEWORK_REPO_SLUG }),
        { silent: true }
      )
    );
    await waitFor(() => expect(reposService.get).toHaveBeenCalledWith('repo-existing'));
    await waitFor(() => expect(onCreateBranch).toHaveBeenCalled());
    expect(onCreateBranch.mock.calls[0]?.[0]).toBe('repo-existing');
  });

  it('reuses an existing framework repo when duplicate clone returns no repo id', async () => {
    const readyRepo = makeRepo({ repo_id: 'repo-existing', default_branch: 'develop' });
    const reposService = {
      find: vi.fn(async () => ({ data: [readyRepo] })),
      get: vi.fn(async () => undefined),
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const boardsService = {
      create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
      setPrimaryTeammate: vi.fn(async () => undefined),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'repos') return reposService;
        return { find: vi.fn(async () => ({ data: [] })) };
      }),
    };
    const onCreateRepo = vi.fn(async () => ({
      status: 'exists' as const,
      slug: FRAMEWORK_REPO_SLUG,
    }));
    const onCreateBranch = vi.fn(async () => makeBranch({ repo_id: 'repo-existing' }));
    const onComplete = vi.fn();

    renderWizard({ client, onCreateRepo, onCreateBranch, onComplete });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /continue without key/i }));

    await waitFor(() => expect(reposService.find).toHaveBeenCalled());
    await waitFor(() =>
      expect(onCreateBranch).toHaveBeenCalledWith(
        'repo-existing',
        expect.objectContaining({ sourceBranch: 'develop' })
      )
    );
    expect(screen.queryByText(/Cloning AI teammate framework/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        branchId: 'branch-1',
        sessionId: 'session-1',
        boardId: 'board-1',
        path: 'teammate',
      })
    );
  });

  it('reuses an existing teammate branch and session when retrying setup', async () => {
    const repoById = new Map<string, Repo>([['repo-1', makeRepo()]]);
    const existingBranch = makeBranch({ board_id: 'board-existing' } as Partial<Branch>);
    const branchesService = { find: vi.fn(async () => ({ data: [existingBranch] })) };
    const sessionsService = {
      find: vi.fn(async () => ({ data: [{ session_id: 'session-existing' }] })),
    };
    const boardsService = {
      create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
      setPrimaryTeammate: vi.fn(async () => undefined),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'branches') return branchesService;
        if (name === 'sessions') return sessionsService;
        return { on: vi.fn(), removeListener: vi.fn() };
      }),
    };
    const onCreateBranch = vi.fn(async () => makeBranch());
    const onCreateSession = vi.fn(async () => 'session-new');
    const onComplete = vi.fn();

    renderWizard({ repoById, client, onCreateBranch, onCreateSession, onComplete });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /continue without key/i }));

    await waitFor(() => expect(branchesService.find).toHaveBeenCalled());
    expect(onCreateBranch).not.toHaveBeenCalled();
    expect(onCreateSession).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        branchId: 'branch-1',
        sessionId: 'session-existing',
        boardId: 'board-existing',
        path: 'teammate',
      })
    );
  });

  it('uses an existing ready framework repo without cloning it again', async () => {
    const repoById = new Map<string, Repo>([['repo-1', makeRepo()]]);
    const onCreateRepo = vi.fn(async () => undefined);
    const onCreateBranch = vi.fn(async () => makeBranch());
    renderWizard({ repoById, onCreateRepo, onCreateBranch });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('button', { name: /continue without key/i }));

    await waitFor(() => expect(onCreateBranch).toHaveBeenCalled());
    expect(onCreateRepo).not.toHaveBeenCalled();
  });

  it('creates setup resources with a user-suffixed teammate branch name and preserves model defaults', async () => {
    const repoById = new Map<string, Repo>();
    const onCreateBranch = vi.fn(async () =>
      makeBranch({ name: 'private-scout-user1', ref: 'private-scout-user1' })
    );
    const onCreateSession = vi.fn(async () => 'session-1');
    const onComplete = vi.fn();
    const user = makeUser({
      default_agentic_config: {
        codex: {
          modelConfig: { model: 'gpt-5', effort: 'high' },
          permissionMode: 'auto',
          mcpServerIds: ['mcp-1'],
          codexSandboxMode: 'workspace-write',
          codexApprovalPolicy: 'on-request',
          codexNetworkAccess: true,
        },
      },
    } as Partial<User>);

    const view = renderWizard({ repoById, onCreateBranch, onCreateSession, onComplete, user });

    fireEvent.change(screen.getByDisplayValue('My Teammate'), { target: { value: 'Scout' } });
    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    const codexOption = Array.from(
      view.baseElement.querySelectorAll<HTMLInputElement>('input[name="recommended-agent"]')
    ).find((option) => option.value === 'codex');
    fireEvent.click(codexOption as HTMLInputElement);
    fireEvent.click(await screen.findByRole('button', { name: /continue with codex cli auth/i }));

    expect(await screen.findByText(/Cloning AI teammate framework/i)).toBeInTheDocument();
    const readyRepoById = new Map(repoById).set('repo-1', makeRepo());
    act(() => {
      agorStore.setState({ repoById: readyRepoById });
    });

    await waitFor(() => {
      expect(onCreateBranch).toHaveBeenCalledWith(
        'repo-1',
        expect.objectContaining({
          name: 'private-scout-user1',
          ref: 'private-scout-user1',
          sourceBranch: 'main',
          createBranch: true,
          pullLatest: true,
          boardId: 'board-1',
        })
      );
    });

    await waitFor(() => {
      expect(onCreateSession).toHaveBeenCalledWith(
        expect.objectContaining({
          branch_id: 'branch-1',
          agent: 'codex',
          modelConfig: { mode: 'exact', model: 'gpt-5' },
          effort: 'high',
          mcpServerIds: ['mcp-1'],
          permissionMode: 'auto',
          codexSandboxMode: 'workspace-write',
          codexApprovalPolicy: 'on-request',
          codexNetworkAccess: true,
        }),
        'board-1'
      );
    });
    expect(onComplete).toHaveBeenCalledWith({
      branchId: 'branch-1',
      sessionId: 'session-1',
      boardId: 'board-1',
      path: 'teammate',
    });
  });

  it('detects an existing Cursor credential when selecting Cursor', async () => {
    renderWizard({
      user: makeUser({
        agentic_tools: {
          cursor: { CURSOR_API_KEY: true },
        },
      } as Partial<User>),
    });

    fireEvent.click(screen.getByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /use a different provider/i }));
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('Cursor SDK (Beta)'));

    expect(await screen.findByText('Cursor SDK is configured')).toBeInTheDocument();
  }, 30_000);
});
