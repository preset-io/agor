/**
 * Tests for the redesigned 5-step OnboardingWizard (persona → llm → workspace →
 * integrations → done).
 *
 * The wizard no longer clones a "framework" repo, auto-creates a branch/session,
 * or offers "continue without key" / codex-cli-auth / provider-combobox affordances
 * inline — that entire auto-provisioning subsystem was removed as part of the
 * redesign (see OnboardingWizard.tsx header comment + commit history). Repo /
 * branch / session creation is deferred to normal in-app flows: the wizard only
 * ever calls onComplete with an empty branchId/sessionId and whatever boardId it
 * created or reused. onCreateRepo / onCreateBranch / onCreateSession are accepted
 * as props (for prop-shape compatibility with the app shell) but are unused by
 * the component (`void`-ed immediately), so this file asserts they are never
 * invoked rather than asserting on their call args.
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

import type { Board, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

function makeBoard(overrides: Partial<Board> = {}): Board {
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

  const boardsService = {
    create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
  };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn((name: string) => (name === 'boards' ? boardsService : {})),
  };
  const onCreateRepo = vi.fn(async () => undefined);
  const onCreateBranch = vi.fn(async () => null);
  const onCreateSession = vi.fn(async () => null);
  const props = {
    open: true,
    onComplete: vi.fn(),
    user: makeUser(),
    client,
    onCreateRepo,
    onCreateLocalRepo: vi.fn(),
    onCreateBranch,
    onCreateSession,
    onUpdateUser: vi.fn(async () => undefined),
    ...componentOverrides,
  } satisfies ComponentProps<typeof OnboardingWizard>;

  return {
    ...render(<OnboardingWizard {...props} />),
    props,
    client,
    boardsService,
    onCreateRepo,
    onCreateBranch,
    onCreateSession,
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
  it('starts on the persona step; selecting a persona advances to LLM and saves onboarding progress', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ onUpdateUser });

    expect(screen.getByText(/let's make this yours/i)).toBeInTheDocument();
    expect(screen.getByText('I write code')).toBeInTheDocument();
    expect(screen.getByText('I manage projects')).toBeInTheDocument();
    // Persona step is optional — no back button on the first step.
    expect(screen.queryByText('Back')).not.toBeInTheDocument();

    clickButton('I write code');
    clickButton(/this is me/i);

    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          preferences: expect.objectContaining({
            onboarding: expect.objectContaining({ persona: 'developer' }),
          }),
        })
      );
    });
  });

  it('disables Continue until a persona is picked; Skip is the only way through unselected', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ onUpdateUser });

    const continueButton = screen.getByText(/^continue/i).closest('button');
    expect(continueButton).toBeDisabled();

    fireEvent.click(continueButton as HTMLButtonElement);
    expect(screen.getByText(/let's make this yours/i)).toBeInTheDocument();

    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('LLM step lists all providers with Claude recommended, and lets the user switch selection', async () => {
    renderWizard({ initialStep: 'llm' });

    expect(screen.getByText('Connect your AI')).toBeInTheDocument();
    expect(screen.getByText('Claude')).toBeInTheDocument();
    expect(screen.getByText('GPT')).toBeInTheDocument();
    expect(screen.getByText('Gemini')).toBeInTheDocument();
    expect(screen.getByText('Custom')).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();

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

  it('saves a valid Claude API key via onCheckAuth + onUpdateUser and advances to workspace', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const onCheckAuth = vi.fn(async () => ({ authenticated: true }));
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
    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();
  });

  it('proceeds to save on an unknown auth result (transient) rather than rejecting the key', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const onCheckAuth = vi.fn(async () => ({ status: 'unknown' as const, authenticated: false }));
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
    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();
  });

  it('blocks with the provider hint on a definitive unauthenticated result', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const onCheckAuth = vi.fn(async () => ({
      status: 'unauthenticated' as const,
      authenticated: false,
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

  it('shows a previously connected provider as verified and lets the user continue without re-entering a key', async () => {
    const onCheckAuth = vi.fn(async () => ({ authenticated: true }));
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({
      initialStep: 'llm',
      onCheckAuth,
      onUpdateUser,
      user: makeUser({
        agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: 'stored-key' } },
      } as Partial<User>),
    });

    // Pre-existing key auto-selects the provider and kicks off a background check.
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();

    clickButton(/^continue/i);

    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();
    // Continuing with an already-verified key does not re-save it.
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('workspace step names the teammate, creates their board and saves progress when no board exists yet', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const { boardsService } = renderWizard({ initialStep: 'workspace', onUpdateUser });

    expect(screen.getByText('Name your AI teammate')).toBeInTheDocument();
    // The teammate name is empty by default — the user names their teammate.
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });

    clickButton(/^continue →/i);

    await waitFor(() => {
      expect(boardsService.create).toHaveBeenCalledWith({ name: 'Rusty', icon: '🤖' });
    });
    await waitFor(() => {
      expect(onUpdateUser).toHaveBeenCalledWith(
        'user-1',
        expect.objectContaining({
          preferences: expect.objectContaining({
            onboarding: expect.objectContaining({ boardId: 'board-1' }),
          }),
        })
      );
    });
    expect(await screen.findByText('Connect your tools via MCP')).toBeInTheDocument();
  });

  it('workspace step skips board creation when the user already has one', async () => {
    const boardById = new Map<string, Board>([['board-existing', makeBoard()]]);
    const { boardsService } = renderWizard({
      initialStep: 'workspace',
      boardById,
      user: makeUser({ preferences: { mainBoardId: 'board-existing' } } as Partial<User>),
    });

    expect(screen.getByText('Board already set up')).toBeInTheDocument();
    expect(screen.getByText('Existing board')).toBeInTheDocument();

    clickButton(/keep going/i);

    expect(boardsService.create).not.toHaveBeenCalled();
    expect(await screen.findByText('Connect your tools via MCP')).toBeInTheDocument();
  });

  it('integrations step shows persona-tailored MCP recommendations', async () => {
    renderWizard({ initialStep: 'integrations' });

    // No persona chosen — falls back to the default rec set.
    expect(screen.getByText('Slack')).toBeInTheDocument();
    expect(screen.getByText('Notion')).toBeInTheDocument();
  });

  it('completes the full flow and calls onComplete with the created board', async () => {
    const onComplete = vi.fn();
    const { onCreateRepo, onCreateBranch, onCreateSession } = renderWizard({ onComplete });

    // persona (optional — Continue is disabled without a selection, so skip)
    clickButton(/skip for now/i);

    // llm
    await findAndClickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: validKey },
    });
    clickButton(/^connect →/i);
    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();

    // workspace — name the teammate, which creates their board
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i);
    expect(await screen.findByText('Connect your tools via MCP')).toBeInTheDocument();

    // integrations
    clickButton(/connect when done/i);

    // done
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    clickButton(/open my board/i);

    // The wizard emits the teammate naming details + selected agent so the app
    // shell can seed the first AI teammate on the created board.
    expect(onComplete).toHaveBeenCalledWith({
      branchId: '',
      sessionId: '',
      boardId: 'board-1',
      path: 'teammate',
      teammateName: 'Rusty',
      teammateEmoji: '🤖',
      agent: 'claude-code',
      // Persona was skipped → the default MCP suggestion set flows through, and
      // the persona threaded to the completion handler is null.
      suggestedIntegrations: ['Slack', 'GitHub', 'Linear', 'Notion'],
      persona: null,
    });
    // The teammate branch/session is created by the app shell on completion, not
    // by the wizard — the wizard itself never invokes these provisioning props.
    expect(onCreateRepo).not.toHaveBeenCalled();
    expect(onCreateBranch).not.toHaveBeenCalled();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('lets the user skip every step without any confirmation dialog', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete });

    expect(screen.getByText(/let's make this yours/i)).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your tools via MCP')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    // Final step is not skippable.
    expect(screen.queryByText(/skip for now/i)).not.toBeInTheDocument();

    clickButton(/open my board/i);
    // Skipping the workspace step leaves the teammate unnamed — no teammateName
    // is emitted, so the app shell skips teammate creation and just opens the board.
    expect(onComplete).toHaveBeenCalledWith({
      branchId: '',
      sessionId: '',
      boardId: '',
      path: 'teammate',
      teammateName: undefined,
      teammateEmoji: '🤖',
      agent: null,
      suggestedIntegrations: ['Slack', 'GitHub', 'Linear', 'Notion'],
      persona: null,
    });
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

    clickButton(/open my board/i);

    // Loading affordance is visible and the button is disabled while pending.
    expect(await screen.findByText(/setting up your ai teammate/i)).toBeInTheDocument();
    const button = screen.getByText(/setting up your ai teammate/i).closest('button');
    expect(button).toBeDisabled();

    // Resolving completion lets the flow finish (parent closes the modal).
    resolveComplete();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
  });

  it('Back navigates to the previous step and preserves prior selections', async () => {
    renderWizard();

    clickButton('I write code');
    clickButton(/this is me/i);
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();

    clickButton('Back');
    expect(await screen.findByText(/let's make this yours/i)).toBeInTheDocument();
  });

  it('dismiss button calls onDismiss and is hidden on the final step', async () => {
    const onDismiss = vi.fn();
    renderWizard({ onDismiss, initialStep: 'done' });

    expect(document.querySelector('button[aria-label="Close"]')).not.toBeInTheDocument();

    renderWizard({ onDismiss, initialStep: 'persona' });
    const closeButtons = document.querySelectorAll('button[aria-label="Close"]');
    expect(closeButtons.length).toBeGreaterThan(0);
    fireEvent.click(closeButtons[closeButtons.length - 1]);
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });
});

describe('Codex ChatGPT login import', () => {
  // Client harness whose codex-auth/import service is controllable per test.
  function renderWithCodexImport(create: ReturnType<typeof vi.fn>) {
    const boardsService = {
      create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) =>
        name === 'boards' ? boardsService : name === 'codex-auth/import' ? { create } : {}
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
    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();
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
    expect(screen.queryByText('Name your AI teammate')).not.toBeInTheDocument();
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
        name === 'codex-auth/device' ? { create, find } : { create: vi.fn(), find: vi.fn() }
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
    expect(await screen.findByText('Name your AI teammate')).toBeInTheDocument();
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
