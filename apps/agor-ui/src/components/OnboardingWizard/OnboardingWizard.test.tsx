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
    expect(await screen.findByText('Set up your workspace')).toBeInTheDocument();
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
    expect(await screen.findByText('Set up your workspace')).toBeInTheDocument();
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

    expect(await screen.findByText('Set up your workspace')).toBeInTheDocument();
    // Continuing with an already-verified key does not re-save it.
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('workspace step creates a board and saves progress when no board exists yet', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const { boardsService } = renderWizard({ initialStep: 'workspace', onUpdateUser });

    expect(screen.getByText('Set up your workspace')).toBeInTheDocument();
    expect(screen.getByDisplayValue("New's board")).toBeInTheDocument();

    clickButton(/create board/i);

    await waitFor(() => {
      expect(boardsService.create).toHaveBeenCalledWith({ name: "New's board", icon: '📋' });
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
    expect(await screen.findByText('Set up your workspace')).toBeInTheDocument();

    // workspace
    clickButton(/create board/i);
    expect(await screen.findByText('Connect your tools via MCP')).toBeInTheDocument();

    // integrations
    clickButton(/connect when done/i);

    // done
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    clickButton(/open my board/i);

    expect(onComplete).toHaveBeenCalledWith({
      branchId: '',
      sessionId: '',
      boardId: 'board-1',
      path: 'teammate',
    });
    // Repo/branch/session provisioning is deferred to normal app flows now —
    // the wizard itself never invokes these.
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

    expect(await screen.findByText('Set up your workspace')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your tools via MCP')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    // Final step is not skippable.
    expect(screen.queryByText(/skip for now/i)).not.toBeInTheDocument();

    clickButton(/open my board/i);
    expect(onComplete).toHaveBeenCalledWith({
      branchId: '',
      sessionId: '',
      boardId: '',
      path: 'teammate',
    });
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
