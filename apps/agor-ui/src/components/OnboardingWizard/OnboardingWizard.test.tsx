/**
 * Tests for the redesigned 4-step OnboardingWizard (goals → workspace [name +
 * template gallery] → llm → done). The in-wizard recommendations step was
 * dropped; routed goal-tailored suggestions still flow through onComplete.
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
import { mergeGoalIntegrationRecs } from '../../utils/onboardingGoals';
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
  const effectiveUser = componentOverrides.user ?? makeUser();

  const boardsService = {
    create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
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
      return {};
    }),
  };
  const onCreateRepo = vi.fn(async () => undefined);
  const onCreateBranch = vi.fn(async () => null);
  const onCreateSession = vi.fn(async () => null);
  const props = {
    open: true,
    onComplete: vi.fn(),
    user: effectiveUser,
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
    usersService,
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

  it('starts on the goals step; selecting a goal advances without saving partial progress', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ onUpdateUser });

    expect(screen.getByText(/what do you want to get done/i)).toBeInTheDocument();
    expect(screen.getByText('Ship without the busywork')).toBeInTheDocument();
    expect(screen.getByText('Dig into anything')).toBeInTheDocument();
    // Goals step is optional — no back button on the first step.
    expect(screen.queryByText('Back')).not.toBeInTheDocument();

    clickButton('Ship without the busywork');
    clickButton(/^continue/i);

    // Goals now flows straight into the name + template gallery step.
    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('renders goal cards as title + description only, with no emoji icon', () => {
    const { baseElement } = renderWizard({ initialStep: 'goals' });
    // The six goal-card emoji that used to sit above each title are gone.
    for (const emoji of ['🔍', '✍️', '🛠️', '👥', '🧱', '🔬']) {
      expect(baseElement.textContent).not.toContain(emoji);
    }
    // Title + description still render.
    expect(screen.getByText('Build me an app')).toBeInTheDocument();
    expect(screen.getByText('A working app or dashboard on a live test env.')).toBeInTheDocument();
  });

  it('gives every goal card an even title→description gap and a one-line description floor', () => {
    renderWizard({ initialStep: 'goals' });
    // The description reserves a single line (not two): every goal description now
    // fits on one line at the 2-col modal width, so a 2-line floor only added dead
    // space and clipped the bottom card row. Row-mates equalize via grid stretch.
    const shortDesc = screen.getByText('PRs, bug triage, and release notes, all handled.');
    expect(shortDesc).toHaveStyle({ minHeight: '1.4em' });
    // The title flows at its natural height with a single consistent gap below.
    // It must NOT reserve a blank second line — doing so made one-line-title
    // cards show a larger title→description gap than two-line ones.
    const shortTitle = screen.getByText('Ship without the busywork');
    expect(shortTitle).not.toHaveStyle({ minHeight: '2.6em' });
    expect(shortTitle).toHaveStyle({ marginBottom: '5px' });
  });

  it('centers the modal so the footer stays on-screen on shorter viewports', () => {
    renderWizard({ initialStep: 'goals' });
    // antd flags a vertically-centered modal with ant-modal-centered on the wrap;
    // this is the layout fix that keeps the Continue/Skip footer visible when the
    // 6-card grid makes the modal tall.
    expect(document.querySelector('.ant-modal-centered')).toBeInTheDocument();
  });

  it('selects a goal on a single click and keeps it selected (no self-deselect)', () => {
    renderWizard({ initialStep: 'goals' });
    const card = screen.getByText('Ship without the busywork').closest('button');
    expect(card).toHaveAttribute('aria-pressed', 'false');
    // One click = exactly one toggle → stays selected. (Regression: a double-fire
    // would flip it straight back to false.)
    fireEvent.click(card as HTMLButtonElement);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    // A second, separate click is what deselects — proving one click = one toggle.
    fireEvent.click(card as HTMLButtonElement);
    expect(card).toHaveAttribute('aria-pressed', 'false');
  });

  it('shows no checkmark on a selected goal card — border + highlight only', () => {
    renderWizard({ initialStep: 'goals' });
    const card = screen
      .getByText('Ship without the busywork')
      .closest('button') as HTMLButtonElement;
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    // The redundant selected-state checkmark is gone; selection is communicated
    // by the border + background highlight alone.
    expect(card.querySelector('.anticon-check')).toBeNull();
  });

  it('does not change a goal card border width on selection (no layout shift)', () => {
    renderWizard({ initialStep: 'goals' });
    const card = screen
      .getByText('Ship without the busywork')
      .closest('button') as HTMLButtonElement;
    // Unselected and selected both use a 1.5px border — only the color changes —
    // so the box model never shifts. A shift here is what made selection read as
    // "it deselected" and baited a re-click.
    const unselectedWidth = card.style.borderTopWidth || card.style.borderWidth;
    expect(unselectedWidth).toBe('1.5px');
    fireEvent.click(card);
    expect(card).toHaveAttribute('aria-pressed', 'true');
    const selectedWidth = card.style.borderTopWidth || card.style.borderWidth;
    expect(selectedWidth).toBe(unselectedWidth);
  });

  it('explains the multi-select interaction and why it matters, not just a mechanic label', () => {
    renderWizard({ initialStep: 'goals' });
    // What to do (pick up to two) AND why (it shapes the first session).
    expect(
      screen.getByText(/pick up to two, and we'll shape your first session around them/i)
    ).toBeInTheDocument();
  });

  it('is multi-select, order-preserving, and caps at two goals', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'goals' });

    // First-picked = primary, second-picked = secondary (order preserved).
    clickButton('Dig into anything');
    clickButton('Ship without the busywork');

    // A third pick is blocked at the cap — its card is marked disabled (aria-disabled
    // keeps it focusable so the explanatory tooltip stays reachable) and clicking
    // it is a no-op rather than a fourth selection.
    const thirdCard = screen.getByText('Build me an app').closest('button');
    expect(thirdCard).toHaveAttribute('aria-disabled', 'true');
    // The reason is exposed to assistive tech (part of the card's name), not hover-only.
    expect(thirdCard).toHaveTextContent('Deselect one to swap it for this.');
    fireEvent.click(thirdCard as HTMLButtonElement);
    expect(thirdCard).toHaveAttribute('aria-pressed', 'false');

    // Advance through the required workspace/tools steps to inspect the emitted
    // goals + merged recommendations.
    clickButton(/^continue/i);
    await findAndClickButton(/skip for now/i); // workspace
    clickButton(/skip for now/i); // llm
    clickButton(/open my board/i);

    // Completion is async (board creation, then onComplete), so wait for it.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          goals: ['dig-into-anything', 'ship-without-busywork'],
          // Merge: first two of primary (dig) then first two of secondary (ship).
          suggestedIntegrations: mergeGoalIntegrationRecs([
            'dig-into-anything',
            'ship-without-busywork',
          ]),
        })
      )
    );
  });

  it('treats Skip as authoritative after experimenting with a goal selection', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'goals' });

    clickButton('Ship without the busywork');
    clickButton(/skip for now/i);
    await findAndClickButton(/skip for now/i); // workspace
    clickButton(/skip for now/i); // llm
    clickButton(/open my board/i);

    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        goals: [],
        suggestedIntegrations: mergeGoalIntegrationRecs([]),
      })
    );
  });

  it('disables Continue until a goal is picked; Skip is the only way through unselected', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    renderWizard({ onUpdateUser });

    const continueButton = screen.getByText(/^continue/i).closest('button');
    expect(continueButton).toBeDisabled();

    fireEvent.click(continueButton as HTMLButtonElement);
    expect(screen.getByText(/what do you want to get done/i)).toBeInTheDocument();

    clickButton(/skip for now/i);

    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('treats Skip as authoritative after experimenting with a goal selection', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'goals' });

    clickButton('Ship without the busywork');
    clickButton(/skip for now/i);
    await findAndClickButton(/skip for now/i); // workspace
    clickButton(/skip for now/i); // llm
    clickButton(/open my board/i);

    // Completion is async (board creation, then onComplete), so wait for it.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          goals: [],
          suggestedIntegrations: mergeGoalIntegrationRecs([]),
        })
      )
    );
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

  it('saves a valid Claude API key via onCheckAuth + onUpdateUser and advances to done', async () => {
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
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
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
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
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

  it('does not save credentials after the authentication owner changes during verification', async () => {
    let current = true;
    let resolveCheck!: (result: { authenticated: true }) => void;
    const onCheckAuth = vi.fn(
      () =>
        new Promise<{ authenticated: true }>((resolve) => {
          resolveCheck = resolve;
        })
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
    resolveCheck({ authenticated: true });
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

    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    // Continuing with an already-verified key does not re-save it.
    expect(onUpdateUser).not.toHaveBeenCalled();
  });

  it('workspace step advances to the LLM step WITHOUT creating a board (creation deferred to completion)', async () => {
    const onUpdateUser = vi.fn(async () => undefined);
    const { boardsService } = renderWizard({ initialStep: 'workspace', onUpdateUser });

    expect(screen.getByText('Build your teammate')).toBeInTheDocument();
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
    const boardsService = {
      create: vi.fn(async () => {
        throw new Error('slug already exists');
      }),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => (name === 'boards' ? boardsService : {})),
    };

    renderWizard({ initialStep: 'workspace', client: client as never });

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i); // workspace → llm (no board yet)
    await findAndClickButton(/skip for now/i); // llm → done
    // The board is created only now, at completion; its rejection surfaces as an
    // inline Alert on the final step and the wizard stays there so the user retries.
    clickButton(/meet rusty/i);

    expect(await screen.findByText('slug already exists')).toBeInTheDocument();
    expect(screen.getByText('Rusty needs one more try.')).toBeInTheDocument();
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
      create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return usersService;
        return {};
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
      create: vi.fn(async () => ({ board_id: 'board-1', created_by: 'user-1' })),
    };
    const client = {
      io: { on: vi.fn(), off: vi.fn() },
      service: vi.fn((name: string) => {
        if (name === 'boards') return boardsService;
        if (name === 'users') return usersService;
        return {};
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
    expect(screen.getByText(/start from a template/i)).toBeInTheDocument();
    const templateCard = screen.getByText('Competitive Analyst');
    expect(screen.getByText('Start blank')).toBeInTheDocument();
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

    // The step title, the name field, and the filter chips are the fixed header —
    // none of them live inside the scrolling card region.
    expect(scrollRegion.contains(screen.getByText('Build your teammate'))).toBe(false);
    expect(scrollRegion.contains(screen.getByLabelText('Teammate name'))).toBe(false);
    const chipGroup = screen.getByRole('radiogroup', { name: 'Filter templates by category' });
    expect(scrollRegion.contains(chipGroup)).toBe(false);

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
    await findAndClickButton(/skip for now/i); // llm
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
        })
      )
    );
  });

  it('treats workspace Skip as authoritative after typing a name and choosing a template', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete, initialStep: 'workspace' });

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    fireEvent.click(screen.getByText('Legal Analyst').closest('[role="button"]') as HTMLElement);
    clickButton(/skip for now/i);
    await findAndClickButton(/skip for now/i); // llm
    clickButton(/open my board/i);

    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith(
        expect.objectContaining({
          teammateName: undefined,
          teammateEmoji: '🤖',
          sourceBranch: undefined,
          templateId: null,
        })
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
    expect(screen.getByText(/new board/i)).toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i); // workspace → llm: still NO board created
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    expect(boardsService.create).not.toHaveBeenCalled();

    await findAndClickButton(/skip for now/i); // llm → done
    clickButton(/meet rusty/i); // completion → create the brand-new board now

    await waitFor(() => {
      expect(boardsService.create).toHaveBeenCalledWith({ name: 'Rusty', icon: '🤖' });
    });
  });

  it('completes the full flow and calls onComplete with the created board', async () => {
    const onComplete = vi.fn();
    const { onCreateRepo, onCreateBranch, onCreateSession } = renderWizard({ onComplete });

    // goals (optional — Continue is disabled without a selection, so skip)
    clickButton(/skip for now/i);

    // workspace — name the teammate (the board is created later, at completion)
    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Teammate name'), { target: { value: 'Rusty' } });
    clickButton(/^continue →/i);

    // llm
    await findAndClickButton('Claude');
    const validKey = `sk-ant-api03-${'x'.repeat(40)}`;
    fireEvent.change(screen.getByLabelText('Anthropic API key'), {
      target: { value: validKey },
    });
    clickButton(/^connect →/i);

    // done — teammate-centric adaptive headline; the primary CTA is verb-first + named.
    expect(await screen.findByText('Rusty is ready.')).toBeInTheDocument();
    clickButton(/meet rusty/i);

    // The wizard creates the board now (at completion) and emits the teammate
    // naming details + selected agent so the app shell can seed the first AI
    // teammate on it. No template was picked → sourceBranch undefined. Board
    // creation precedes onComplete, so await it.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        branchId: '',
        sessionId: '',
        boardId: 'board-1',
        path: 'teammate',
        teammateName: 'Rusty',
        teammateEmoji: '🤖',
        sourceBranch: undefined,
        sourceRemoteUrl: undefined,
        templateId: null,
        agent: 'claude-code',
        // Goals were skipped → the default MCP suggestion set flows through, and
        // the goals threaded to the completion handler are empty.
        suggestedIntegrations: mergeGoalIntegrationRecs([]),
        goals: [],
      })
    );
    // The teammate branch/session is created by the app shell on completion, not
    // by the wizard — the wizard itself never invokes these provisioning props.
    expect(onCreateRepo).not.toHaveBeenCalled();
    expect(onCreateBranch).not.toHaveBeenCalled();
    expect(onCreateSession).not.toHaveBeenCalled();
  });

  it('done step heroes the named teammate with a role pill + adaptive headline and NO recap line (template picked)', async () => {
    renderWizard();

    // goals — pick one
    clickButton('Ship without the busywork');
    clickButton(/^continue →/i);

    // workspace — name + template (Product Manager → role pill + its avatar emoji)
    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();
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

    // done — teammate-centric: name heroes the headline, the template is the role
    // pill, and one warm "it's yours; shape it by chatting" subline — nothing else.
    expect(await screen.findByText('Rusty is ready.')).toBeInTheDocument();
    expect(screen.getByText('Product Manager')).toBeInTheDocument(); // role pill
    expect(
      screen.getByText(
        "Rusty is all yours. Start a chat and tell them what you need. You'll shape how they work as you go."
      )
    ).toBeInTheDocument();
    // The single primary action is verb-first + named into the first session.
    expect(screen.getByText(/^meet rusty →$/i)).toBeInTheDocument();
    // The recap line is GONE: neither the provider nor the goal is echoed on the
    // success screen (only the hero avatar, headline, subcopy, role pill, CTA).
    expect(screen.queryByText('Claude')).not.toBeInTheDocument();
    expect(screen.queryByText('Ship without the busywork')).not.toBeInTheDocument();
    // The old dominating checklist + "What we set up" caption are gone.
    expect(screen.queryByText('What we set up')).not.toBeInTheDocument();
    expect(screen.queryByText(/open my board/i)).not.toBeInTheDocument();
  });

  it('done step shows a warm generic success when the teammate was left unnamed (no checklist)', async () => {
    renderWizard();

    clickButton(/skip for now/i); // goals
    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();
    clickButton(/skip for now/i); // workspace — no name, no template
    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    clickButton(/skip for now/i); // llm

    // No teammate to hero → the warm generic headline + board-open subcopy, and the
    // old skip-hint checklist is gone entirely.
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    expect(
      screen.getByText("Your board is ready. Open it and start whenever you're ready.")
    ).toBeInTheDocument();
    expect(screen.queryByText('What we set up')).not.toBeInTheDocument();
    expect(screen.queryByText(/Skipped —/)).not.toBeInTheDocument();
    expect(screen.getByText(/open my board/i)).toBeInTheDocument(); // unnamed → generic CTA
  });

  it('lets the user skip every step without any confirmation dialog', async () => {
    const onComplete = vi.fn();
    renderWizard({ onComplete });

    expect(screen.getByText(/what do you want to get done/i)).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText('Connect your AI')).toBeInTheDocument();
    clickButton(/skip for now/i);

    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
    // Final step is not skippable.
    expect(screen.queryByText(/skip for now/i)).not.toBeInTheDocument();

    clickButton(/open my board/i);
    // Skipping the workspace step leaves the teammate unnamed — no teammateName
    // is emitted, so the app shell skips teammate creation. A board is still
    // always created (with a generic default name) so the user lands on one.
    await waitFor(() =>
      expect(onComplete).toHaveBeenCalledWith({
        branchId: '',
        sessionId: '',
        boardId: 'board-1',
        path: 'teammate',
        teammateName: undefined,
        teammateEmoji: '🤖',
        sourceBranch: undefined,
        sourceRemoteUrl: undefined,
        templateId: null,
        agent: null,
        suggestedIntegrations: mergeGoalIntegrationRecs([]),
        goals: [],
      })
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

    clickButton(/open my board/i);

    // Loading affordance is visible and the button is disabled while pending.
    expect(await screen.findByText(/setting up/i)).toBeInTheDocument();
    const button = screen.getByText(/setting up/i).closest('button');
    expect(button).toBeDisabled();

    // Resolving completion lets the flow finish (parent closes the modal).
    resolveComplete();
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
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
    expect(onComplete.mock.calls[1][0].boardId).toBe('board-1');
  });

  it('resumes an incomplete setup from its saved, still-visible board', async () => {
    const onComplete = vi.fn();
    const resumedBoard = makeBoard({ board_id: 'board-resume', name: 'Rusty', icon: '⚖️' });
    const user = makeUser({
      preferences: {
        onboarding: {
          boardId: 'board-resume',
          goals: ['ship-without-busywork'],
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

    expect(await screen.findByText('Rusty is ready.')).toBeInTheDocument();
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
      })
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
    clickButton('Back');
    await screen.findByText('Connect your AI');
    clickButton('Back');
    await screen.findByText('Build your teammate');
    fireEvent.click(screen.getByText('Start blank').closest('[role="button"]') as HTMLElement);
    clickButton(/^continue →$/i);
    await screen.findByText('Connect your AI');
    clickButton(/skip for now/i);

    expect(await screen.findByText('Rusty is ready.')).toBeInTheDocument();
    expect(screen.queryByText(/removed-template.*no longer available/i)).not.toBeInTheDocument();
    clickButton(/meet rusty/i);
    await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    expect(onComplete).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'board-resume',
        templateId: 'blank',
        sourceBranch: undefined,
        sourceRemoteUrl: undefined,
      })
    );
  });

  it('exposes progress semantics and moves focus to the new step heading', async () => {
    renderWizard({ initialStep: 'goals' });

    const progress = screen.getByRole('list', { name: 'Onboarding progress' });
    expect(progress).toHaveTextContent('Step 1 of 4: Goals. Current step.');
    expect(progress.querySelector('[aria-current="step"]')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(/what do you want to get done/i)).toHaveFocus());

    clickButton(/skip for now/i);
    const heading = await screen.findByText('Build your teammate');
    await waitFor(() => expect(heading).toHaveFocus());

    const scroller = screen.getByRole('group', { name: 'Teammate template' })
      .parentElement as HTMLElement;
    scroller.scrollTop = 40;
    fireEvent.scroll(scroller);
    expect(document.activeElement?.closest('[aria-hidden="true"]')).toBeNull();
  });

  it('Back navigates to the previous step and preserves prior selections', async () => {
    renderWizard();

    clickButton('Ship without the busywork');
    clickButton(/^continue/i);
    expect(await screen.findByText('Build your teammate')).toBeInTheDocument();

    clickButton('Back');
    expect(await screen.findByText(/what do you want to get done/i)).toBeInTheDocument();
    // The prior goal selection survives the round-trip.
    expect(screen.getByText('Ship without the busywork').closest('button')).toHaveAttribute(
      'aria-pressed',
      'true'
    );
  });

  it('dismiss button calls onDismiss and is hidden on the final step', async () => {
    const onDismiss = vi.fn();
    renderWizard({ onDismiss, initialStep: 'done' });

    expect(document.querySelector('button[aria-label="Close"]')).not.toBeInTheDocument();

    renderWizard({ onDismiss, initialStep: 'goals' });
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
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
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
    expect(screen.queryByText('Build your teammate')).not.toBeInTheDocument();
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

  it('keeps a successfully registered subscription usable when later verification is unknown', async () => {
    const onCheckAuth = vi.fn(async () => ({
      status: 'unknown' as const,
      authenticated: false,
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
    expect(await screen.findByText("You're ready to build.")).toBeInTheDocument();
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
