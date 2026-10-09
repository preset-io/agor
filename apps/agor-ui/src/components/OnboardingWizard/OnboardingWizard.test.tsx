/**
 * Tests for the 4-step OnboardingWizard (workspace [name + template gallery]
 * → llm → tools → done). The tools step is a browsable Catalog wall that only
 * opens the existing Catalog drawer; nothing is selected or stored.
 *
 * The wizard no longer clones a "framework" repo, auto-creates a branch/session,
 * or offers "continue without key" / codex-cli-auth / provider-combobox affordances
 * inline — that entire auto-provisioning subsystem was removed as part of the
 * redesign (see OnboardingWizard.tsx header comment + commit history). Repo /
 * branch / session creation is deferred to normal in-app flows: the wizard only
 * ever calls onComplete with an empty branchId/sessionId and whatever boardId it
 * created or reused. Resource creation outside the board is deferred to the
 * app shell, so this file asserts those services are never requested.
 *
 * Note on query style: this file intentionally avoids `getByRole('button', ...)`
 * / `queryByRole(...)` for interacting with buttons. The LLM and integrations
 * steps render `antd` `Tag` elements, and computing an accessible name for ANY
 * button while one is mounted walks into the Tag's stylesheet rule
 * (`border: var(--ant-line-width) ...`), which crashes jsdom's `cssstyle`
 * (5.3.2) — a pre-existing environment/library incompatibility (antd v6 default
 * `cssVar` theming + a jsdom `cssstyle` shorthand-parsing bug), not a bug in the
 * component. Plain text queries (`getByText(...).closest('button')`) sidestep
 * the accessible-name computation entirely and are used throughout instead.
 */

import type { AgorClient, Board, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { EMPTY_MAPS } from '../../store/agorMaps';
import { agorStore } from '../../store/agorStore';
import { OnboardingWizard } from './OnboardingWizard';

const { TEST_BOARD_ID } = vi.hoisted(() => ({
  TEST_BOARD_ID: '01933e4a-7b89-7c35-a8f3-9d2e1c4b5a6f',
}));

vi.mock('@agor/core/ids/browser', () => ({
  generateId: () => TEST_BOARD_ID,
}));

vi.mock('../EmojiPickerInput/EmojiPickerInput', () => ({
  EmojiPickerInput: ({ value, onChange }: { value: string; onChange: (value: string) => void }) => (
    <button type="button" onClick={() => onChange(value)} aria-label="emoji picker">
      {value}
    </button>
  ),
}));

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

function makeBoard(
  overrides: Partial<Omit<Board, 'board_id'>> & { board_id?: string } = {}
): Board {
  return {
    board_id: 'board-existing',
    name: 'Existing board',
    ...overrides,
  } as Board;
}

// The wizard self-subscribes to boardById from the store (rather than receiving
// it as a prop), so the harness seeds that slice into the store rather than
// passing it through as a component prop.
function renderWizard(
  overrides: Partial<ComponentProps<typeof OnboardingWizard>> & {
    boardById?: Map<string, Board>;
  } = {}
) {
  const { boardById, ...componentOverrides } = overrides;
  agorStore.setState({
    ...EMPTY_MAPS,
    ...(boardById ? { boardById } : {}),
  });
  const effectiveUser = componentOverrides.user ?? makeUser();

  const boardsService = {
    create: vi.fn(async (data: Partial<Board>) => ({
      ...data,
      board_id: data.board_id,
      created_by: 'user-1',
    })),
    patch: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
  };
  const usersService = {
    get: vi.fn(async () => effectiveUser),
  };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => {
      if (name === 'boards') return boardsService;
      if (name === 'users') return usersService;
      return {
        on: vi.fn(),
        off: vi.fn(),
        get: vi.fn(async () => ({ state: 'no_auth' })),
        find: vi.fn(async () => ({ data: [] })),
      };
    }),
  };
  const props = {
    open: true,
    onComplete: vi.fn(),
    user: effectiveUser,
    client: client as unknown as AgorClient,
    onUpdateUser: vi.fn(async () => undefined),
    ...componentOverrides,
  } satisfies ComponentProps<typeof OnboardingWizard>;

  return {
    ...render(<OnboardingWizard {...props} />),
    props,
    client,
    boardsService,
    usersService,
  };
}

// Finds the ancestor <button> for a given piece of text and clicks it. Several
// onboarding cards render the whole card (emoji/title/description) as one
// clickable button, so `getByText` (which finds the innermost element holding
// the exact text) + `closest('button')` is more robust than role-based
// queries here — see the file-level note above for why role queries are
// avoided entirely in this file.
function clickButton(text: string | RegExp) {
  const el = screen.getByText(text);
  const button = el.closest('button');
  if (!button) throw new Error(`No ancestor <button> found for text "${text}"`);
  fireEvent.click(button);
}

async function findAndClickButton(text: string | RegExp) {
  const el = await screen.findByText(text);
  const button = el.closest('button');
  if (!button) throw new Error(`No ancestor <button> found for text "${text}"`);
  fireEvent.click(button);
}

describe('OnboardingWizard', () => {
  it.each(['API key', 'Subscription token'] as const)(
    'replaces an unavailable backend grant through explicit %s input',
    async (method) => {
      const onUpdateUser = vi.fn(async () => undefined);
      renderWizard({
        initialStep: 'llm',
        user: makeUser({
          agentic_auth_methods: { 'claude-code': 'subscription' },
          agentic_credential_sources: { 'claude-code': 'managed_oauth' },
        }),
        allowClaudeOAuthSignIn: false,
        claudeOAuthCapability: { available: false, storage: null, reason: 'operator_disabled' },
        onUpdateUser,
      });
      await findAndClickButton('Claude');
      clickButton(method);
      const key =
        method === 'API key' ? `sk-ant-api03-${'x'.repeat(40)}` : 'synthetic-pasted-subscription';
      const input = screen.getByLabelText(
        method === 'API key' ? 'Anthropic API key' : 'Claude subscription token'
      );
      expect(screen.getByText(/^connect →/i).closest('button')).toBeDisabled();
      fireEvent.change(input, { target: { value: key } });
      clickButton(/^connect →/i);
      await waitFor(() =>
        expect(onUpdateUser).toHaveBeenCalledWith('user-1', {
          agentic_tools: {
            'claude-code': {
              [method === 'API key' ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN']: key,
            },
          },
        })
      );
    }
  );

  it('uses the shared animated glass highlights behind its content', () => {
    const { baseElement } = renderWizard();

    expect(baseElement.querySelector('[data-glass-highlights="strong"]')).toHaveAttribute(
      'aria-hidden',
      'true'
    );
    expect(baseElement.querySelectorAll('[data-glass-highlight]')).toHaveLength(2);
    expect(
      Array.from(baseElement.querySelectorAll('style'))
        .map((style) => style.textContent)
        .join('\n')
    ).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('starts on the teammate step: there is no goals step', () => {
    renderWizard();

    expect(screen.getByText('Hi New, meet your teammate')).toBeInTheDocument();
    expect(screen.queryByText(/what do you want to get done/i)).not.toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Onboarding progress' })).toHaveTextContent(
      'Step 1 of 4: Teammate. Current step.'
    );
    expect(screen.queryByText('Back')).not.toBeInTheDocument();
  });

  it('centers the modal so the footer stays on-screen on shorter viewports', () => {
    renderWizard();
    expect(document.querySelector('.ant-modal-centered')).toBeInTheDocument();
  });

  it('preselects the Team assistant and completes on the blank framework', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete });

    const assistant = screen.getByText('Team assistant').closest('[role="button"]');
    expect(assistant).toHaveAttribute('aria-pressed', 'true');
    // Re-clicking the default keeps it selected instead of leaving nothing picked.
    fireEvent.click(assistant as HTMLElement);
    expect(assistant).toHaveAttribute('aria-pressed', 'true');

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Ada' } });
    clickButton(/^continue/i);
    await findAndClickButton(/skip for now/i); // llm
    clickButton(/^continue/i); // tools
    clickButton(/meet ada/i);

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          templateId: 'blank',
          sourceBranch: undefined,
          sourceRemoteUrl: undefined,
        }),
        expect.objectContaining({ isCurrent: expect.any(Function) })
      )
    );
    expect(onComplete.mock.calls[0][0]).not.toHaveProperty('goals');
  });

  it('LLM step recommends only Claude and Codex (GPT), and lets the user switch selection', async () => {
    renderWizard({ initialStep: 'llm' });

    expect(screen.getByText('Connect your AI')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('GPT')).toBeInTheDocument();
    expect(screen.getByText('Gemini')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getAllByText('Recommended')).toHaveLength(2);
    for (const title of ['Claude', 'GPT']) {
      expect(screen.getByText(title).closest('button')).toHaveTextContent('Recommended');
    }
    for (const title of ['Gemini', 'Custom']) {
      expect(screen.getByText(title).closest('button')).not.toHaveTextContent('Recommended');
    }

    // No key input until a provider is selected.
    expect(screen.queryByLabelText(/API key/i)).not.toBeInTheDocument();

    clickButton('GPT');
    expect(screen.getByLabelText('OpenAI API key')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('sk-proj-…')).toBeInTheDocument();
  });

  it('validates the API key format for the selected provider before enabling Connect', async () => {
    renderWizard({ initialStep: 'llm' });

    clickButton('Claude');
    const input = screen.getByLabelText('Anthropic API key');
    fireEvent.change(input, { target: { value: 'not-a-real-key' } });

    const errorText = await screen.findByText(/Claude keys start with sk-ant-/i);
    expect(errorText).toBeInTheDocument();
    const connectButton = screen.getByText(/^connect →/i).closest('button');
    expect(connectButton).toBeDisabled();
  });

  it('saves a valid Claude API key via onCheckAuth + onUpdateUser and advances to done', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const onCheckAuth = vi.fn(async () => ({
      status: 'authenticated' as const,
      authenticated: true,
      method: 'api-key' as const,
    }));
    renderWizard({ initialStep: 'llm', onUpdateUser, onCheckAuth });

    clickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: validKey },
    });
    clickButton(/^connect →/i);

    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code', validKey));
    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: validKey } },
        })
      );
    });
    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
  });

  it('proceeds to save on an unknown auth result (transient) rather than rejecting the key', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const onCheckAuth = vi.fn(async () => ({
      status: 'unknown' as const,
      authenticated: false,
      method: 'none' as const,
    }));
    renderWizard({ initialStep: 'llm', onUpdateUser, onCheckAuth });

    clickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: validKey } });
    clickButton(/^connect →/i);

    // 'unknown' is not a definitive rejection: the key is still saved and we advance.
    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: validKey } },
        })
      );
    });
    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
  });

  it('blocks with the provider hint on a definitive unauthenticated result', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const onCheckAuth = vi.fn(async () => ({
      status: 'unauthenticated' as const,
      authenticated: false,
      method: 'api-key' as const,
      hint: 'Key rejected by provider.',
    }));
    renderWizard({ initialStep: 'llm', onUpdateUser, onCheckAuth });

    clickButton('Claude');
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: `sk-ant-api03-${'x'.repeat(40)}` },
    });
    clickButton(/^connect →/i);

    expect(await screen.findByText('Key rejected by provider.')).toBeInTheDocument();
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('does not save credentials after the authentication owner changes during verification', async () => {
    let current = true;
    let resolveCheck!: (result: {
      status: 'authenticated';
      authenticated: true;
      method: 'api-key';
    }) => void;
    const onCheckAuth = vi.fn(
      () =>
        new Promise<{ status: 'authenticated'; authenticated: true; method: 'api-key' }>(
          (resolve) => {
            resolveCheck = resolve;
          }
        )
    );
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({
      initialStep: 'llm',
      isCurrent: () => current,
      onCheckAuth,
      onUpdateUser,
    });

    clickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), { target: { value: validKey } });
    clickButton(/^connect →/i);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code', validKey));

    current = false;
    resolveCheck({
      status: 'authenticated' as const,
      authenticated: true,
      method: 'api-key' as const,
    });
    await Promise.resolve();

    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('can save a Claude subscription token instead of an API key', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ initialStep: 'llm', onUpdateUser });

    clickButton('Claude');
    clickButton('Subscription token');
    expect(screen.getByText(/claude setup-token/)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Claude subscription token'), {
      target: { value: 'token-from-cli' },
    });
    clickButton(/^connect →/i);

    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          agentic_tools: { 'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'token-from-cli' } },
        })
      );
    });
  });

  it('hides Claude OAuth unless the daemon capability is explicitly enabled', () => {
    const { client } = renderWizard({ initialStep: 'llm' });

    clickButton('Claude');

    expect(screen.queryByText('Sign in with Claude')).not.toBeInTheDocument();
    expect(screen.getByText('API key')).toBeInTheDocument();
    expect(screen.getByText('Subscription token')).toBeInTheDocument();
    expect(client.service).not.toHaveBeenCalledWith('claude-auth/oauth');
  });

  it('offers the capability-gated Claude OAuth flow alongside both existing alternatives', async () => {
    const create = vi.fn(async () => ({
      phase: 'awaiting_code',
      attemptId: 'attempt-1',
      verificationUrl: 'https://claude.example/authorize',
    }));
    const find = vi.fn(async () => ({ phase: 'idle' }));
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name === 'claude-auth/oauth' ? { create, find } : { create: vi.fn(), find: vi.fn() }
      ),
    };
    renderWizard({
      initialStep: 'llm',
      client: client as never,
      allowClaudeOAuthSignIn: true,
    });

    clickButton('Claude');
    expect(screen.getByText('API key')).toBeInTheDocument();
    expect(screen.getByText('Subscription token')).toBeInTheDocument();
    const methodGroup = screen.getByRole('group', {
      name: 'Claude authentication method',
    });
    expect(methodGroup.querySelector('button[aria-pressed="true"]')).toHaveTextContent('API key');
    expect(methodGroup.querySelectorAll('button[aria-pressed]')).toHaveLength(3);
    expect(
      screen.getByText('Encrypted at rest and not added to prompt transcripts or logs.')
    ).toBeInTheDocument();
    clickButton('Sign in with Claude');

    await waitFor(() => expect(create).toHaveBeenCalledWith({}));
    expect(methodGroup.querySelector('button[aria-pressed="true"]')).toHaveTextContent(
      'Sign in with Claude'
    );
    expect(
      screen.getByText(
        /stores the resulting refreshable login in your private per-user execution home/i
      )
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Encrypted at rest and not added to prompt transcripts or logs.')
    ).not.toBeInTheDocument();
    expect((await screen.findByText('Open the Claude sign-in page')).closest('a')).toHaveAttribute(
      'href',
      'https://claude.example/authorize'
    );
    expect(screen.getByLabelText('Claude authorization code')).toBeInTheDocument();
    expect(screen.getByText(/^connect →/i).closest('button')).toBeDisabled();
  });

  it('enables continuation only after Claude OAuth succeeds', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        phase: 'awaiting_code',
        attemptId: 'attempt-1',
        verificationUrl: 'https://claude.example/authorize',
      })
      .mockResolvedValueOnce({
        phase: 'success',
        attemptId: 'attempt-1',
        hint: 'Signed in with Claude.',
      });
    const find = vi.fn(async () => ({ phase: 'idle' }));
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name === 'claude-auth/oauth'
          ? { create, find }
          : { create: vi.fn(), find: vi.fn(async () => ({ data: [] })), on: vi.fn(), off: vi.fn() }
      ),
    };
    renderWizard({
      initialStep: 'llm',
      client: client as never,
      allowClaudeOAuthSignIn: true,
    });

    clickButton('Claude');
    clickButton('Sign in with Claude');
    const codeInput = await screen.findByLabelText('Claude authorization code');
    fireEvent.change(codeInput, { target: { value: 'CODE#STATE' } });
    fireEvent.keyDown(codeInput, { key: 'Enter', code: 'Enter' });

    await waitFor(() =>
      expect(create).toHaveBeenLastCalledWith({
        code: 'CODE#STATE',
        attemptId: 'attempt-1',
      })
    );
    await waitFor(() => expect(screen.getByText(/^continue →/i).closest('button')).toBeEnabled());
    clickButton(/^continue →/i);
    expect(await screen.findByText('Connect your teammate')).toBeInTheDocument();
    expect(screen.queryByText('Your teammate is almost ready.')).not.toBeInTheDocument();
    for (const service of ['repos', 'branches', 'sessions']) {
      expect(client.service).not.toHaveBeenCalledWith(service);
    }
    await findAndClickButton(/skip for now/i);
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
  });

  it('strips whitespace picked up from a wrapped terminal paste before saving a subscription token', async () => {
    // `claude setup-token` prints a long token that a narrow terminal soft-wraps
    // across lines; copying the wrapped output can carry an embedded newline.
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ initialStep: 'llm', onUpdateUser });

    clickButton('Claude');
    clickButton('Subscription token');

    fireEvent.change(screen.getByLabelText('Claude subscription token'), {
      target: { value: 'sk-ant-oat01-abc\n123-def456' },
    });
    clickButton(/^connect →/i);

    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          agentic_tools: {
            'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-abc123-def456' },
          },
        })
      );
    });
  });

  it('shows a previously connected provider as verified and lets the user continue without re-entering a key', async () => {
    const onCheckAuth = vi.fn(async () => ({
      status: 'authenticated' as const,
      authenticated: true,
      method: 'api-key' as const,
    }));
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({
      initialStep: 'llm',
      onCheckAuth,
      onUpdateUser,
      user: makeUser({
        agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      } as Partial<User>),
    });

    // Pre-existing key auto-selects the provider and kicks off a background check.
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();

    clickButton(/^continue/i);

    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
    // Continuing with an already-verified key does not re-save it.
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it.each([
    ['missing', undefined],
    ['false', false],
  ] as const)(
    'fails closed for a managed Claude login when the runtime capability is %s',
    async (_label, allowClaudeOAuthSignIn) => {
      const onCheckAuth = vi.fn(async () => ({
        status: 'unknown' as const,
        authenticated: false,
        method: 'none' as const,
      }));
      renderWizard({
        initialStep: 'llm',
        user: makeUser({
          agentic_auth_methods: { 'claude-code': 'subscription' },
          agentic_credential_sources: { 'claude-code': 'managed_file' },
        } as Partial<User>),
        onCheckAuth,
        ...(allowClaudeOAuthSignIn === undefined ? {} : { allowClaudeOAuthSignIn }),
      });

      // Let the mount effects and one deferred task settle before checking the
      // negative path; an immediate waitFor assertion can pass before the
      // capability-gated auth check would have had a chance to run.
      await act(async () => {
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      });
      expect(onCheckAuth).not.toHaveBeenCalled();
      expect(screen.queryByText('Connected')).not.toBeInTheDocument();
      expect(screen.queryByText('Sign in with Claude')).not.toBeInTheDocument();
      expect(screen.getByText('Connect →').closest('button')).toBeDisabled();

      clickButton('Claude');
      expect(screen.getByLabelText('Anthropic API key')).toBeInTheDocument();
      expect(screen.getByText('Subscription token')).toBeInTheDocument();
      expect(screen.getByText('Connect →').closest('button')).toBeDisabled();
    }
  );

  it('keeps a managed Claude login usable after a wizard remount when its cheap probe is inconclusive and the runtime capability is available', async () => {
    const onCheckAuth = vi.fn(async () => ({
      status: 'unknown' as const,
      authenticated: false,
      method: 'none' as const,
    }));
    renderWizard({
      initialStep: 'llm',
      user: makeUser({
        agentic_auth_methods: { 'claude-code': 'subscription' },
        agentic_credential_sources: { 'claude-code': 'managed_file' },
      } as Partial<User>),
      onCheckAuth,
      allowClaudeOAuthSignIn: true,
    });

    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText(/^continue/i).closest('button')).toBeEnabled();
  });

  it('workspace step advances to the LLM step WITHOUT creating a board (creation deferred to completion)', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const { boardsService } = renderWizard({ initialStep: 'workspace', onUpdateUser });

    expect(screen.getByText('Hi New, meet your teammate')).toBeInTheDocument();
    // The teammate name is empty by default — the user names their teammate.
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });

    clickButton(/^continue →/i);

    // Step 2 no longer creates a board (that's deferred to completion so an
    // abandoned run never leaves an orphan board) — Continue just advances.
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    expect(boardsService.create).not.toHaveBeenCalled();
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('surfaces a board-creation failure at COMPLETION as an inline error on the final step', async () => {
    const user = makeUser();
    const boardsService = {
      create: vi.fn(async () => {
        throw new Error('slug already exists');
      }),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return { get: vi.fn(async () => user) };
        return {
          on: vi.fn(),
          off: vi.fn(),
          get: vi.fn(async () => ({ state: 'no_auth' })),
          find: vi.fn(async () => ({ data: [] })),
        };
      }),
    };

    renderWizard({ initialStep: 'workspace', client: client as never });

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i); // workspace → llm (no board yet)
    await findAndClickButton(/skip for now/i); // llm → tools
    await findAndClickButton(/skip for now/i); // tools → done
    // The board is created only now, at completion; its rejection surfaces as an
    // inline Alert on the final step and the wizard stays there so the user retries.
    clickButton(/meet rusty/i);

    expect(await screen.findByText('slug already exists')).toBeInTheDocument();
    expect(screen.getByText('Rusty needs one more try.')).toBeInTheDocument();
  });

  it('discovers a board committed before an ambiguous create response failed', async () => {
    const user = makeUser();
    const boardsService = {
      create: vi.fn(async () => {
        throw new Error('response disconnected');
      }),
      get: vi.fn(async (boardId: string) => ({ board_id: boardId, created_by: user.user_id })),
    };
    const usersService = { get: vi.fn(async () => user) };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return usersService;
        return {
          on: vi.fn(),
          off: vi.fn(),
          get: vi.fn(async () => ({ state: 'no_auth' })),
          find: vi.fn(async () => ({ data: [] })),
        };
      }),
    };
    const onComplete = vi.fn();

    renderWizard({ client: client as never, initialStep: 'done', onComplete });
    clickButton(/open my board/i);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(boardsService.create).toHaveBeenCalledTimes(1);
    expect(boardsService.get).toHaveBeenCalledWith(TEST_BOARD_ID);
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({ boardId: TEST_BOARD_ID }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    );
  });

  it('does not persist progress or complete after an identity switch during the latest-user read', async () => {
    let current = true;
    let resolveUser!: (user: User) => void;
    const usersService = {
      get: vi.fn(
        () =>
          new Promise<User>((resolve) => {
            resolveUser = resolve;
          })
      ),
    };
    const boardsService = {
      create: vi.fn(async () => ({ board_id: TEST_BOARD_ID, created_by: 'user-1' })),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return usersService;
        return {
          on: vi.fn(),
          off: vi.fn(),
          get: vi.fn(async () => ({ state: 'no_auth' })),
          find: vi.fn(async () => ({ data: [] })),
        };
      }),
    };
    const onUpdateUser = vi.fn(async () => undefined);
    const onComplete = vi.fn();
    renderWizard({
      initialStep: 'done',
      client: client as never,
      isCurrent: () => current,
      onUpdateUser,
      onComplete,
    });

    clickButton(/open my board/i);
    await waitFor(() => expect(usersService.get).toHaveBeenCalledTimes(1));
    current = false;
    resolveUser(makeUser());
    await Promise.resolve();

    expect(onUpdateUser).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not complete an old wizard after a same-user remount during progress persistence', async () => {
    let current = true;
    let resolveUpdate!: () => void;
    const onUpdateUser = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        })
    );
    const onComplete = vi.fn();
    renderWizard({
      initialStep: 'done',
      isCurrent: () => current,
      onUpdateUser,
      onComplete,
    });

    clickButton(/open my board/i);
    await waitFor(() => expect(onUpdateUser).toHaveBeenCalledTimes(1));
    current = false;
    resolveUpdate();
    await Promise.resolve();

    expect(onComplete).not.toHaveBeenCalled();
  });

  it('does not revive an invalidated operation after reopening for the same auth owner', async () => {
    const oldOwner = { userId: 'user-1', authenticationGeneration: 4, activationGeneration: 1 };
    let currentOwner: typeof oldOwner | null = oldOwner;
    let resolveUser!: (user: User) => void;
    const usersService = {
      get: vi.fn(
        () =>
          new Promise<User>((resolve) => {
            resolveUser = resolve;
          })
      ),
    };
    const boardsService = {
      create: vi.fn(async () => ({ board_id: TEST_BOARD_ID, created_by: 'user-1' })),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return usersService;
        return {
          on: vi.fn(),
          off: vi.fn(),
          get: vi.fn(async () => ({ state: 'no_auth' })),
          find: vi.fn(async () => ({ data: [] })),
        };
      }),
    };
    const onUpdateUser = vi.fn(async () => undefined);
    const onComplete = vi.fn();
    const rendered = renderWizard({
      initialStep: 'done',
      client: client as never,
      isCurrent: () => currentOwner === oldOwner,
      onUpdateUser,
      onComplete,
    });

    clickButton(/open my board/i);
    await waitFor(() => expect(usersService.get).toHaveBeenCalledTimes(1));

    // Eligibility loss invalidates the old operation. Reopening without a new
    // login still receives a fresh activation generation, so the old retained
    // promise must never become current again.
    currentOwner = null;
    const reopenedOwner = { ...oldOwner, activationGeneration: 2 };
    currentOwner = reopenedOwner;
    rendered.rerender(
      <OnboardingWizard
        {...rendered.props}
        key={reopenedOwner.activationGeneration}
        isCurrent={() => currentOwner === reopenedOwner}
      />
    );

    resolveUser(makeUser());
    await Promise.resolve();

    expect(onUpdateUser).not.toHaveBeenCalled();
    expect(onComplete).not.toHaveBeenCalled();
  });

  it('workspace step renders the template gallery below the name field', () => {
    renderWizard({ initialStep: 'workspace' });

    const nameField = screen.getByLabelText('Teammate name');
    expect(screen.getByText('Or start from a template')).toBeInTheDocument();
    const templateCard = screen.getByText('Competitive Analyst');
    expect(screen.getByText('Team assistant')).toBeInTheDocument();
    // Onboarding drops the category chips; descriptions live in tooltips.
    expect(screen.queryByRole('radiogroup')).not.toBeInTheDocument();
    expect(screen.queryByText(/Tracks every rival/)).not.toBeInTheDocument();
    // The gallery sits after the name field.
    expect(
      nameField.compareDocumentPosition(templateCard) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
  });

  it('renders step 2 as two regions: a non-scrolling header and a separate overflow scroll region holding the card grid', () => {
    // Structural (jsdom) replacement for the old real-browser overlap test. The
    // cards live in their OWN overflow-y:auto container, a separate sibling from
    // the header block — so a card can never paint over the pinned header in ANY
    // browser (the guarantee is the DOM structure, not sticky/z-index).
    renderWizard({ initialStep: 'workspace' });

    const grid = screen.getByRole('group', { name: 'Teammate template' });
    const scrollRegion = grid.parentElement as HTMLElement;
    expect(scrollRegion.getAttribute('style') ?? '').toContain('overflow-y: auto');

    // The step title and the name field are the fixed header — neither lives
    // inside the scrolling card region.
    expect(scrollRegion.contains(screen.getByText('Hi New, meet your teammate'))).toBe(false);
    expect(scrollRegion.contains(screen.getByLabelText('Teammate name'))).toBe(false);

    // The step container itself does not scroll — step 2 delegates all scrolling
    // to the inner card region, so the header physically can't be overlapped.
    const stepContainer = document.querySelector('.onb-step') as HTMLElement;
    expect(stepContainer.getAttribute('style') ?? '').toContain('overflow: hidden');
  });

  it('workspace step sets the avatar from a chosen template and flows its source branch on completion', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'workspace' });

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    // Picking a template sets the default avatar (emoji) but never the name.
    // Gallery cards are role="button" divs, not buttons — click the card directly.
    const legalCard = screen.getByText('Legal Analyst').closest('[role="button"]');
    fireEvent.click(legalCard as HTMLElement);
    expect(screen.getByLabelText('Teammate name')).toHaveValue('Rusty');

    clickButton(/^continue →/i); // workspace → llm
    await findAndClickButton(/skip for now/i); // llm → tools
    await findAndClickButton(/skip for now/i); // tools → done
    clickButton(/meet rusty/i); // named teammate → verb-first primary CTA

    // Board creation now precedes onComplete (both at completion), so await it.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          teammateName: 'Rusty',
          teammateEmoji: '⚖️',
          sourceBranch: 'template/legal-analyst',
          sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
          templateId: 'legal-analyst',
        }),
        expect.objectContaining({ isCurrent: expect.any(Function) })
      )
    );
  });

  it('treats workspace Skip as authoritative after typing a name and choosing a template', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'workspace' });

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    fireEvent.click(screen.getByText('Legal Analyst').closest('[role="button"]') as HTMLElement);
    clickButton(/skip for now/i);
    await findAndClickButton(/skip for now/i); // llm → tools
    await findAndClickButton(/skip for now/i); // tools → done
    clickButton(/open my board/i);

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          teammateName: undefined,
          teammateEmoji: '🤖',
          sourceBranch: undefined,
          templateId: null,
        }),
        expect.objectContaining({ isCurrent: expect.any(Function) })
      )
    );
  });

  it('creates a NEW board only at completion, even when the user already has one (never reuses it)', async () => {
    // The user already has a board (mainBoardId + hydrated store). Per the 1:1
    // teammate↔board convention, onboarding must STILL create a fresh board named
    // after the teammate and never reuse/join the existing one — and only at the end.
    const boardById = new Map<string, Board>([['board-existing', makeBoard()]]);
    const { boardsService } = renderWizard({
      initialStep: 'workspace',
      boardById,
      user: makeUser({ preferences: { mainBoardId: 'board-existing' } } as Partial<User>),
    });

    // Helper copy promises a fresh board made at the end — never "join your existing board".
    expect(screen.queryByText(/join your existing board/i)).not.toBeInTheDocument();
    expect(screen.getByText(/get their own board/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i); // workspace → llm: still NO board created
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    expect(boardsService.create).not.toHaveBeenCalled();

    await findAndClickButton(/skip for now/i); // llm → tools
    await findAndClickButton(/skip for now/i); // tools → done
    clickButton(/meet rusty/i); // completion → create the brand-new board now

    await waitFor(() => {
      expect(boardsService.create).toHaveBeenCalledWith({
        board_id: TEST_BOARD_ID,
        name: 'Rusty',
        icon: '🤖',
      });
    });
  });

  it('completes the full flow and calls onComplete with the created board', async () => {
    const onComplete = vi.fn();
    const { client } = renderWizard({ onComplete });

    // workspace — name the teammate (the board is created later, at completion)
    expect(await screen.findByText('Hi New, meet your teammate')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i);

    // llm
    await findAndClickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: validKey },
    });
    clickButton(/^connect →/i);

    // tools — curate step skipped, then the teammate-centric done hero.
    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Rusty is almost ready.')).toBeInTheDocument();
    clickButton(/meet rusty/i);

    // The wizard creates the board now (at completion) and emits the teammate
    // naming details + selected agent so the app shell can seed the first AI
    // teammate on it. The default Team assistant → sourceBranch undefined. Board
    // creation precedes onComplete, so await it.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        {
          branchId: '',
          sessionId: '',
          boardId: TEST_BOARD_ID,
          path: 'teammate',
          teammateName: 'Rusty',
          teammateEmoji: '🤖',
          sourceBranch: undefined,
          sourceRemoteUrl: undefined,
          templateId: 'blank',
          agent: 'claude-code',
          connectedMcpServerIds: [],
        },
        expect.objectContaining({ isCurrent: expect.any(Function) })
      )
    );
    // The teammate branch/session is created by the app shell on completion, not
    // by the wizard — it never requests those provisioning services.
    for (const service of ['repos', 'branches', 'sessions']) {
      expect(client.service).not.toHaveBeenCalledWith(service);
    }
  });

  it('done step heroes the named teammate with a role pill + adaptive headline and NO recap line (template picked)', async () => {
    renderWizard();

    // workspace — name + template (Product Manager → role pill + its avatar emoji)
    expect(await screen.findByText('Hi New, meet your teammate')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    const templateCard = screen.getByText('Product Manager').closest('[role="button"]');
    fireEvent.click(templateCard as HTMLElement);
    clickButton(/^continue →/i);

    // llm — connect Claude
    await findAndClickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: validKey },
    });
    clickButton(/^connect →/i);

    // tools — curate step skipped, then the teammate-centric done hero: name heroes
    // the headline, the template is the role pill, and one warm subline — nothing else.
    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Rusty is almost ready.')).toBeInTheDocument();
    expect(screen.getByText('Product Manager')).toBeInTheDocument(); // role pill
    expect(
      screen.getByText("Next, we'll set up Rusty's board and open your first chat.")
    ).toBeInTheDocument();
    // The single primary action is verb-first + named into the first session.
    expect(screen.getByText(/^meet rusty →$/i)).toBeInTheDocument();
    // The recap line is GONE: the provider is not echoed on the success screen
    // (only the hero avatar, headline, subcopy, role pill, CTA).
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    // The old dominating checklist + "What we set up" caption are gone.
    expect(screen.queryByText('What we set up')).not.toBeInTheDocument();
    expect(screen.queryByText(/open my board/i)).not.toBeInTheDocument();
  });

  it('done step shows a warm generic success when the teammate was left unnamed (no checklist)', async () => {
    renderWizard();

    expect(await screen.findByText('Hi New, meet your teammate')).toBeInTheDocument();
    clickButton(/skip for now/i); // workspace — no name, no template
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    clickButton(/skip for now/i); // llm
    await findAndClickButton(/skip for now/i); // tools

    // No teammate to hero → the warm generic headline + board-open subcopy, and the
    // old skip-hint checklist is gone entirely.
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
    expect(screen.getByText("Next, we'll set up your board.")).toBeInTheDocument();
    expect(screen.queryByText('What we set up')).not.toBeInTheDocument();
    expect(screen.queryByText(/Skipped —/)).not.toBeInTheDocument();
    expect(screen.getByText(/open my board/i)).toBeInTheDocument(); // unnamed → generic CTA
  });

  it('lets the user skip every step without any confirmation dialog', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete });

    expect(await screen.findByText('Hi New, meet your teammate')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your teammate')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
    // Final step is not skippable.
    expect(screen.queryByText(/skip for now/i)).not.toBeInTheDocument();

    clickButton(/open my board/i);
    // Skipping the workspace step leaves the teammate unnamed — no teammateName
    // is emitted, so the app shell skips teammate creation. A board is still
    // always created (with a generic default name) so the user lands on one.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        {
          branchId: '',
          sessionId: '',
          boardId: TEST_BOARD_ID,
          path: 'teammate',
          teammateName: undefined,
          teammateEmoji: '🤖',
          sourceBranch: undefined,
          sourceRemoteUrl: undefined,
          templateId: null,
          agent: null,
          connectedMcpServerIds: [],
        },
        expect.objectContaining({ isCurrent: expect.any(Function) })
      )
    );
  });

  it('shows a loading state on the final step while onComplete is in flight', async () => {
    // onComplete stays pending until we resolve it — mirrors the app shell
    // creating the teammate + navigating before the modal closes.
    let resolveComplete: () => void = () => {};
    const onComplete = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveComplete = resolve;
        })
    );
    renderWizard({ onComplete, initialStep: 'done' });

    expect(screen.getByText('Your teammate is almost ready.')).toBeInTheDocument();
    expect(screen.queryByText('Chat in Slack')).not.toBeInTheDocument();
    clickButton(/open my board/i);

    // Loading affordance is visible and the button is disabled while pending.
    expect(await screen.findByText('Setting up…')).toBeInTheDocument();
    expect(screen.getByText('Setting up…').closest('button')).toBeDisabled();
    expect(screen.getByText('Setting up your board…')).toBeInTheDocument();
    // Setup tips fill the wait, outside any live region.
    const tip = screen.getByText('Chat in Slack');
    expect(tip.closest('[aria-live]')).toBeNull();
    expect(
      screen.getByText(
        'Connect a Slack channel and your team can ask your teammate for help right there.'
      )
    ).toBeInTheDocument();

    // Resolving completion lets the flow finish (parent closes the modal).
    resolveComplete();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('names the teammate while setting up and hides the tips on error', async () => {
    let rejectComplete: (error: Error) => void = () => {};
    const onComplete = vi.fn(
      () =>
        new Promise<void>((_, reject) => {
          rejectComplete = reject;
        })
    );
    renderWizard({
      onComplete,
      user: makeUser({ preferences: { onboarding: { teammateDisplayName: 'Ada' } } }),
    });
    clickButton(/^continue/i); // workspace
    await findAndClickButton(/skip for now/i); // llm
    clickButton(/^continue/i); // tools
    expect(screen.getByText('Ada is almost ready.')).toBeInTheDocument();
    expect(
      screen.getByText("Next, we'll set up Ada's board and open your first chat.")
    ).toBeInTheDocument();
    clickButton(/meet ada/i);

    expect(await screen.findByText('Setting up Ada…')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask for a dashboard, a prototype or a report. Ada builds it as an artifact on your board.'
      )
    ).toBeInTheDocument();

    rejectComplete(new Error('workspace failed'));
    expect(await screen.findByText('workspace failed')).toBeInTheDocument();
    expect(screen.getByText('Ada needs one more try.')).toBeInTheDocument();
    expect(screen.queryByText('Chat in Slack')).not.toBeInTheDocument();
  });

  it('welcomes the user by first name, with a fallback when there is none', () => {
    const named = renderWizard({ user: makeUser({ name: 'Kasia Kowalska' }) });
    expect(screen.getByText('Hi Kasia, meet your teammate')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your teammate is your AI helper. They work with you and your team, and remember how you like things done.'
      )
    ).toBeInTheDocument();
    expect(screen.getByText("They'll get their own board when you finish.")).toBeInTheDocument();
    expect(screen.getByText('Pick a starting point')).toBeInTheDocument();
    named.unmount();

    renderWizard({ user: makeUser({ name: '' }) });
    expect(screen.getByText('Hi there, meet your teammate')).toBeInTheDocument();
  });

  it('single-flights a double final click and creates/writes each resource once', async () => {
    const onComplete = vi.fn(async () => undefined);
    const { boardsService, usersService, props } = renderWizard({
      onComplete,
      initialStep: 'done',
    });
    const finalButton = screen.getByText(/open my board/i).closest('button')!;

    // Same-turn duplicate delivery bypasses a React disabled-state-only guard.
    fireEvent.click(finalButton);
    fireEvent.click(finalButton);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(boardsService.create).toHaveBeenCalledTimes(1);
    expect(usersService.get).toHaveBeenCalledTimes(1);
    expect(props.onUpdateUser).toHaveBeenCalledTimes(1);
    expect(vi.mocked(props.onUpdateUser).mock.invocationCallOrder[0]).toBeLessThan(
      boardsService.create.mock.invocationCallOrder[0]
    );
  });

  it('does not offer retry after the slow warning until provisioning settles', async () => {
    let rejectFirst!: (error: Error) => void;
    const firstCompletion = new Promise<void>((_resolve, reject) => {
      rejectFirst = reject;
    });
    const onComplete = vi
      .fn<NonNullable<ComponentProps<typeof OnboardingWizard>['onComplete']>>()
      .mockReturnValueOnce(firstCompletion)
      .mockResolvedValueOnce(undefined);
    const { boardsService } = renderWizard({
      onComplete,
      initialStep: 'done',
      completionSlowThresholdMs: 20,
    });

    clickButton(/open my board/i);
    await waitFor(() =>
      expect(screen.getByText(/setup is taking longer than expected/i)).toBeVisible()
    );
    expect(onComplete).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[0][1].isCurrent()).toBe(true);
    expect(screen.queryByText(/^try again →$/i)).not.toBeInTheDocument();
    expect(screen.getByText(/^still finishing…$/i).closest('button')).toBeDisabled();

    rejectFirst(new Error('Provisioning eventually failed'));
    expect(await screen.findByText('Provisioning eventually failed')).toBeVisible();

    clickButton(/^try again →$/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(boardsService.create).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[1][1].isCurrent()).toBe(true);
  });

  it('persists the candidate id before create and retries a failed progress write without an orphan', async () => {
    const onComplete = vi.fn(async () => undefined);
    const { boardsService, props } = renderWizard({ onComplete, initialStep: 'done' });
    vi.mocked(props.onUpdateUser).mockRejectedValueOnce(new Error('Progress write failed'));

    clickButton(/open my board/i);
    expect(await screen.findByText('Progress write failed')).toBeInTheDocument();
    expect(boardsService.create).not.toHaveBeenCalled();

    clickButton(/^try again →$/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(boardsService.create).toHaveBeenCalledOnce();
    expect(boardsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ board_id: TEST_BOARD_ID })
    );
  });

  it('reuses the board when completion fails and the user retries', async () => {
    const onComplete = vi
      .fn<NonNullable<ComponentProps<typeof OnboardingWizard>['onComplete']>>()
      .mockRejectedValueOnce(new Error('Preference write failed'))
      .mockResolvedValueOnce(undefined);
    const { boardsService } = renderWizard({ onComplete, initialStep: 'done' });

    clickButton(/open my board/i);
    expect(await screen.findByText('Setup needs one more try.')).toBeInTheDocument();
    expect(screen.getByText('Preference write failed')).toBeInTheDocument();

    clickButton(/^try again →$/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(2));
    expect(boardsService.create).toHaveBeenCalledTimes(1);
    expect(onComplete.mock.calls[1][0].boardId).toBe(TEST_BOARD_ID);
  });

  it('reuses a persisted candidate after dismiss and remount before board creation', async () => {
    const onComplete = vi.fn(async () => undefined);
    const user = makeUser({
      preferences: {
        onboarding: {
          boardId: TEST_BOARD_ID,
          deferredAt: '2026-08-29T12:00:00.000Z',
          teammateDisplayName: 'Rusty',
          teammateEmoji: '⚖️',
          teammateTemplateId: 'legal-analyst',
        },
      },
    });
    const { boardsService } = renderWizard({ onComplete, user });

    expect(await screen.findByText('Rusty is almost ready.')).toBeInTheDocument();
    clickButton(/meet rusty/i);

    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(boardsService.create).toHaveBeenCalledOnce();
    expect(boardsService.create).toHaveBeenCalledWith(
      expect.objectContaining({ board_id: TEST_BOARD_ID })
    );
  });

  it('restores saved selections before a board has been allocated', async () => {
    const onComplete = vi.fn();
    const { boardsService } = renderWizard({
      onComplete,
      user: makeUser({
        preferences: {
          onboarding: {
            teammateDisplayName: 'Rusty',
            teammateEmoji: '⚖️',
            teammateTemplateId: 'legal-analyst',
          },
        },
      }),
    });
    expect(screen.getByDisplayValue('Rusty')).toBeInTheDocument();
    expect(screen.getByText('Legal Analyst').closest('[role="button"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
    expect(boardsService.create).not.toHaveBeenCalled();
    clickButton(/continue/i);
    clickButton(/skip for now/i); // AI
    clickButton(/skip for now/i); // Tools
    clickButton(/meet rusty/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        teammateName: 'Rusty',
        teammateEmoji: '⚖️',
        templateId: 'legal-analyst',
      }),
      expect.anything()
    );
  });

  it('resumes an incomplete setup from its saved, still-visible board', async () => {
    const onComplete = vi.fn();
    const resumedBoard = makeBoard({ board_id: 'board-resume', name: 'Rusty', icon: '⚖️' });
    const user = makeUser({
      preferences: {
        onboarding: {
          boardId: 'board-resume',
          teammateDisplayName: 'Rusty',
          teammateEmoji: '⚖️',
          teammateTemplateId: 'legal-analyst',
        },
      },
    });
    const { boardsService } = renderWizard({
      onComplete,
      user,
      boardById: new Map([[resumedBoard.board_id, resumedBoard]]),
    });

    expect(await screen.findByText('Rusty is almost ready.')).toBeInTheDocument();
    clickButton(/meet rusty/i);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(boardsService.create).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'board-resume',
        teammateName: 'Rusty',
        templateId: 'legal-analyst',
        sourceBranch: 'template/legal-analyst',
        sourceRemoteUrl: 'https://github.com/preset-io/agor-teammate.git',
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    );
  });

  it('blocks a resumed setup with a stale template instead of silently using the default branch', async () => {
    const onComplete = vi.fn();
    const resumedBoard = makeBoard({ board_id: 'board-resume', name: 'Rusty', icon: '⚖️' });
    const user = makeUser({
      preferences: {
        onboarding: {
          boardId: 'board-resume',
          teammateDisplayName: 'Rusty',
          teammateTemplateId: 'removed-template',
        },
      },
    });
    const { boardsService } = renderWizard({
      onComplete,
      user,
      boardById: new Map([[resumedBoard.board_id, resumedBoard]]),
    });

    expect(
      await screen.findByText(
        'Saved teammate template "removed-template" is no longer available. Go back and choose another template.'
      )
    ).toBeInTheDocument();
    clickButton(/^try again →$/i);

    expect(onComplete).not.toHaveBeenCalled();
    expect(boardsService.create).not.toHaveBeenCalled();
    expect(screen.getByText(/removed-template.*no longer available/i)).toBeInTheDocument();

    // Recovery clears the derived validation error immediately rather than
    // leaving a stale copy in the independent board-creation error state.
    clickButton('Back'); // done → tools
    await screen.findByText('Connect your teammate');
    clickButton('Back'); // tools → llm
    await screen.findByText('Connect your AI');
    clickButton('Back'); // llm → workspace
    await screen.findByText('Hi New, meet your teammate');
    fireEvent.click(screen.getByText('Team assistant').closest('[role="button"]') as HTMLElement);
    clickButton(/^continue →$/i);
    await screen.findByText('Connect your AI');
    clickButton(/skip for now/i); // llm → tools
    await screen.findByText('Connect your teammate');
    clickButton(/skip for now/i); // tools → done

    expect(await screen.findByText('Rusty is almost ready.')).toBeInTheDocument();
    expect(screen.queryByText(/removed-template.*no longer available/i)).not.toBeInTheDocument();
    clickButton(/meet rusty/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'board-resume',
        templateId: 'blank',
        sourceBranch: undefined,
        sourceRemoteUrl: undefined,
      }),
      expect.objectContaining({ isCurrent: expect.any(Function) })
    );
  });

  it.each([false, true])(
    'can skip a removed saved template and complete without a teammate (saved board: %s)',
    async (hasBoard) => {
      const onComplete = vi.fn();
      const board = makeBoard({ board_id: TEST_BOARD_ID });
      const { boardsService } = renderWizard({
        onComplete,
        boardById: hasBoard ? new Map([[board.board_id, board]]) : undefined,
        user: makeUser({
          preferences: {
            onboarding: {
              ...(hasBoard ? { boardId: board.board_id } : {}),
              teammateDisplayName: 'Rusty',
              teammateTemplateId: 'removed-template',
            },
          },
        }),
      });
      if (hasBoard) {
        expect(
          await screen.findByText(/removed-template.*no longer available/i)
        ).toBeInTheDocument();
        clickButton('Back'); // done → tools
        clickButton('Back'); // tools → llm
        clickButton('Back'); // llm → workspace
      }
      expect(screen.getByDisplayValue('Rusty')).toBeInTheDocument();
      clickButton(/skip for now/i); // workspace → llm
      clickButton(/skip for now/i); // llm → tools
      clickButton(/skip for now/i); // tools → done
      expect(screen.queryByText(/removed-template.*no longer available/i)).not.toBeInTheDocument();
      clickButton(/open my board/i);
      await waitFor(() => expect(onComplete).toHaveBeenCalledOnce());
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          boardId: TEST_BOARD_ID,
          teammateName: undefined,
          templateId: null,
          sourceBranch: undefined,
        }),
        expect.anything()
      );
      expect(boardsService.create).toHaveBeenCalledTimes(hasBoard ? 0 : 1);
    }
  );

  it('exposes progress semantics and moves focus to the new step heading', async () => {
    renderWizard({ initialStep: 'llm' });

    const progress = screen.getByRole('list', { name: 'Onboarding progress' });
    expect(progress).toHaveTextContent('Step 2 of 4: AI. Current step.');
    expect(progress.querySelector('[aria-current="step"]')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Connect your AI')).toHaveFocus());

    clickButton('Back');
    const heading = await screen.findByText('Hi New, meet your teammate');
    await waitFor(() => expect(heading).toHaveFocus());

    const scroller = screen.getByRole('group', { name: 'Teammate template' })
      .parentElement as HTMLElement;
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    expect(document.activeElement?.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('Back navigates to the previous step and preserves prior selections', async () => {
    renderWizard();

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    fireEvent.click(screen.getByText('Legal Analyst').closest('[role="button"]') as HTMLElement);
    clickButton(/^continue/i);
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();

    clickButton('Back');
    expect(await screen.findByText('Hi New, meet your teammate')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Rusty')).toBeInTheDocument();
    expect(screen.getByText('Legal Analyst').closest('[role="button"]')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('lets the user dismiss with X or Escape, including from the final step', async () => {
    const onDismiss = vi.fn();
    const final = renderWizard({ onDismiss, initialStep: 'done' });

    const finalClose = document.querySelector('button[aria-label="Close"]');
    expect(finalClose).toBeEnabled();
    fireEvent.click(finalClose as HTMLButtonElement);
    expect(onDismiss).toHaveBeenCalledTimes(1);

    final.unmount();
    renderWizard({ onDismiss });
    fireEvent.keyDown(document, { key: 'Escape', code: 'Escape' });
    await waitFor(() => expect(onDismiss).toHaveBeenCalledTimes(2));
  });

  it('lets the user dismiss a hung final provisioning attempt and retires it', async () => {
    const onDismiss = vi.fn();
    const onComplete = vi.fn(() => new Promise<void>(() => {})) as NonNullable<
      ComponentProps<typeof OnboardingWizard>['onComplete']
    >;
    renderWizard({ onDismiss, onComplete, initialStep: 'done' });

    clickButton(/open my board/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    const attempt = vi.mocked(onComplete).mock.calls[0][1];
    const close = document.querySelector('button[aria-label="Close"]');
    await waitFor(() => expect(close).toBeEnabled());

    fireEvent.click(close as HTMLButtonElement);

    expect(onDismiss).toHaveBeenCalledWith(expect.objectContaining({ boardId: TEST_BOARD_ID }));
    expect(attempt.isCurrent()).toBe(false);
  });

  it('tools step is a browsable wall with nothing to select or store', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'tools' });

    expect(screen.getByText('Connect your teammate')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Your teammate can work with all of these tools. Connect one now, or skip and do it later.'
      )
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Search tools')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    expect(screen.getByText('Skip for now')).toBeInTheDocument();

    clickButton(/^continue →/i);
    clickButton(/open my board/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete.mock.calls[0][0]).toMatchObject({ connectedMcpServerIds: [] });
    expect(onComplete.mock.calls[0][0]).not.toHaveProperty('suggestedIntegrations');
  });
});

describe('Codex ChatGPT login import', () => {
  // Client harness whose codex-auth/import service is controllable per test.
  function renderWithCodexImport(create: ReturnType<typeof vi.fn>) {
    const boardsService = {
      create: vi.fn(async () => ({ board_id: TEST_BOARD_ID, created_by: 'user-1' })),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name === 'boards'
          ? boardsService
          : name === 'codex-auth/import'
            ? { create }
            : {
                on: vi.fn(),
                off: vi.fn(),
                get: vi.fn(async () => ({ state: 'no_auth' })),
                find: vi.fn(async () => ({ data: [] })),
              }
      ),
    };
    const rendered = renderWizard({ initialStep: 'llm', client: client as never });
    return { ...rendered, importCreate: create };
  }

  it('offers an auth-method toggle for GPT and reveals the paste flow with inline help', async () => {
    renderWizard({ initialStep: 'llm' });

    clickButton('GPT');
    expect(screen.getByText('Sign in with ChatGPT')).toBeInTheDocument();
    expect(screen.getByText('Import auth.json')).toBeInTheDocument();

    clickButton('Import auth.json');
    expect(screen.getByLabelText('Codex auth.json contents')).toBeInTheDocument();
    // Inline help: where the file lives, how to print it, and the overwrite caveat.
    expect(screen.getByText(/cat ~\/\.codex\/auth\.json/)).toBeInTheDocument();
    expect(
      screen.getByText(/replaces the Codex login already stored on this server/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/one login for the whole server/i)).toBeInTheDocument();
    // No API-key format validation applies to a pasted file.
    expect(screen.queryByText(/OpenAI keys start with/i)).not.toBeInTheDocument();
  });

  it('submits the pasted auth.json to the daemon and advances on success', async () => {
    const create = vi.fn(async () => ({ status: 'authenticated', authMode: 'chatgpt' }));
    const { importCreate } = renderWithCodexImport(create);

    clickButton('GPT');
    clickButton('Import auth.json');
    const pasted = JSON.stringify({ OPENAI_API_KEY: null, tokens: { refresh_token: 'r' } });
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: pasted },
    });
    // The import pane owns its own submit; success self-advances the wizard.
    clickButton('Import login');

    await waitFor(() => expect(importCreate).toHaveBeenCalledWith({ authJson: pasted }));
    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
  });

  it('shows the daemon rejection message and stays on the LLM step', async () => {
    const create = vi.fn(async () => {
      throw new Error('This file has no ChatGPT login tokens and no API key.');
    });
    renderWithCodexImport(create);

    clickButton('GPT');
    clickButton('Import auth.json');
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: '{"tokens":{}}' },
    });
    clickButton('Import login');

    expect(
      await screen.findByText(/This file has no ChatGPT login tokens and no API key\./)
    ).toBeInTheDocument();
    expect(screen.getByText('Connect your AI')).toBeInTheDocument();
    expect(screen.queryByText('Hi New, meet your teammate')).not.toBeInTheDocument();
  });

  it('switching auth methods clears the pasted value and error state', async () => {
    const create = vi.fn(async () => {
      throw new Error('This file has no ChatGPT login tokens and no API key.');
    });
    renderWithCodexImport(create);

    clickButton('GPT');
    clickButton('Import auth.json');
    fireEvent.change(screen.getByLabelText('Codex auth.json contents'), {
      target: { value: '{"a":1}' },
    });
    clickButton('Import login');
    expect(
      await screen.findByText(/This file has no ChatGPT login tokens and no API key\./)
    ).toBeInTheDocument();

    clickButton('API key');
    const keyInput = screen.getByLabelText('OpenAI API key') as HTMLInputElement;
    expect(keyInput.value).toBe('');
    // A stale rejection from the paste attempt must not linger on the API-key pane.
    expect(
      screen.queryByText(/This file has no ChatGPT login tokens and no API key\./)
    ).not.toBeInTheDocument();
  });

  it('describes a broken ChatGPT login in subscription terms, not API-key terms', async () => {
    // Stored method is subscription but the server-side auth.json is gone
    // (wipe / `codex logout`) — the probe reports unauthenticated.
    const onCheckAuth = vi.fn(async () => ({
      status: 'unauthenticated' as const,
      authenticated: false,
      method: 'none' as const,
    }));
    renderWizard({
      initialStep: 'llm',
      user: makeUser({ agentic_auth_methods: { codex: 'subscription' } } as never),
      onCheckAuth,
    });

    expect(await screen.findByText('Login not found')).toBeInTheDocument();
    expect(screen.queryByText('Key not working')).not.toBeInTheDocument();

    clickButton('GPT');
    expect(
      await screen.findByText(/Codex login no longer found on this server/i)
    ).toBeInTheDocument();
    expect(screen.queryByText(/Key stored but not working/)).not.toBeInTheDocument();
  });

  it('keeps a successfully registered subscription usable when later verification is unknown', async () => {
    const onCheckAuth = vi.fn(async () => ({
      status: 'unknown' as const,
      authenticated: false,
      method: 'none' as const,
    }));
    renderWizard({
      initialStep: 'llm',
      user: makeUser({ agentic_auth_methods: { codex: 'subscription' } } as never),
      onCheckAuth,
    });

    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByText('Continue →')).toBeInTheDocument();
    expect(screen.queryByText('Checking…')).not.toBeInTheDocument();
  });
});

describe('Codex ChatGPT device sign-in', () => {
  // Client harness with a controllable codex-auth/device service.
  function renderWithDeviceService(overrides: {
    create?: ReturnType<typeof vi.fn>;
    find?: ReturnType<typeof vi.fn>;
  }) {
    const create =
      overrides.create ??
      vi.fn(async () => ({
        phase: 'pending',
        userCode: 'ABCD-1234',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }));
    const find = overrides.find ?? vi.fn(async () => ({ phase: 'idle' }));
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name === 'codex-auth/device'
          ? { create, find }
          : {
              create: vi.fn(),
              find: vi.fn(async () => ({ data: [] })),
              on: vi.fn(),
              off: vi.fn(),
              get: vi.fn(async () => ({ state: 'no_auth' })),
            }
      ),
    };
    const rendered = renderWizard({ initialStep: 'llm', client: client as never });
    return { ...rendered, deviceCreate: create, deviceFind: find };
  }

  function openDevicePane() {
    clickButton('GPT');
    clickButton('Sign in with ChatGPT');
  }

  it('requests a code on selection and shows it with the verification link and expiry', async () => {
    const { deviceCreate } = renderWithDeviceService({});
    openDevicePane();

    await waitFor(() => expect(deviceCreate).toHaveBeenCalledTimes(1));
    expect(await screen.findByText('ABCD-1234')).toBeInTheDocument();
    expect(screen.getByText(/auth\.openai\.com\/codex\/device/)).toBeInTheDocument();
    expect(screen.getByText(/waiting for approval/i)).toBeInTheDocument();
    expect(screen.getByText(/code expires in/i)).toBeInTheDocument();
    // Approval has not happened — Connect stays disabled.
    expect(screen.getByText(/^connect →/i).closest('button')).toBeDisabled();
  });

  it('advances once the daemon reports success', async () => {
    const find = vi.fn().mockResolvedValueOnce({ phase: 'idle' }).mockResolvedValue({
      phase: 'success',
      planType: 'pro',
      hint: 'Signed in with ChatGPT (pro plan).',
    });
    renderWithDeviceService({ find });
    openDevicePane();

    // The 2s status poll flips the pane to success.
    expect(
      await screen.findByText(/signed in with chatgpt \(pro plan\)/i, {}, { timeout: 5000 })
    ).toBeInTheDocument();

    // The pane reports success to the parent via effect — enablement lands a tick later.
    await waitFor(() => expect(screen.getByText(/^connect →/i).closest('button')).toBeEnabled());
    const connect = screen.getByText(/^connect →/i).closest('button');
    fireEvent.click(connect as HTMLButtonElement);
    await findAndClickButton(/skip for now/i); // tools → done
    expect(await screen.findByText('Your teammate is almost ready.')).toBeInTheDocument();
  });

  it('treats a gated account as a first-class state with working fallbacks', async () => {
    const create = vi.fn(async () => ({
      phase: 'unavailable',
      hint: 'Your ChatGPT account does not allow device-code sign-in.',
    }));
    renderWithDeviceService({ create });
    openDevicePane();

    expect(
      await screen.findByText(/device sign-in is turned off for this chatgpt account/i)
    ).toBeInTheDocument();
    expect(screen.getByText(/device code authorization for codex/i)).toBeInTheDocument();

    clickButton('Paste a login file');
    expect(screen.getByLabelText('Codex auth.json contents')).toBeInTheDocument();
  });

  it('offers a fresh code after expiry', async () => {
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        phase: 'expired',
        hint: 'The sign-in code expired — get a new one and try again.',
      })
      .mockResolvedValue({
        phase: 'pending',
        userCode: 'WXYZ-9876',
        verificationUrl: 'https://auth.openai.com/codex/device',
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      });
    renderWithDeviceService({ create });
    openDevicePane();

    expect(await screen.findByText(/code expired/i)).toBeInTheDocument();
    await findAndClickButton(/get a new code/i);
    expect(await screen.findByText('WXYZ-9876')).toBeInTheDocument();
  });

  it('adopts a still-pending attempt instead of burning a fresh code', async () => {
    const find = vi.fn(async () => ({
      phase: 'pending',
      userCode: 'KEEP-0001',
      verificationUrl: 'https://auth.openai.com/codex/device',
      expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    }));
    const create = vi.fn();
    renderWithDeviceService({ create, find });
    openDevicePane();

    expect(await screen.findByText('KEEP-0001')).toBeInTheDocument();
    // The adopted attempt's expiry drives the countdown just like a fresh one.
    expect(await screen.findByText(/code expires in/i)).toBeInTheDocument();
    expect(create).not.toHaveBeenCalled();
  });
});
