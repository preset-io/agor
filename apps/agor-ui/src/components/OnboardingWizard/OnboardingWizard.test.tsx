import type { User } from '@agor-live/client';
import { fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps } from 'react';
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

function renderWizard(overrides: Partial<ComponentProps<typeof OnboardingWizard>> = {}) {
  const reposService = { on: vi.fn(), removeListener: vi.fn() };
  const client = {
    io: { on: vi.fn(), off: vi.fn() },
    service: vi.fn(() => reposService),
  };

  return render(
    <OnboardingWizard
      open={true}
      onComplete={vi.fn()}
      repoById={new Map()}
      branchById={new Map()}
      boardById={new Map()}
      user={makeUser()}
      client={client}
      onCreateRepo={vi.fn()}
      onCreateLocalRepo={vi.fn()}
      onCreateBranch={vi.fn()}
      onCreateSession={vi.fn()}
      onUpdateUser={vi.fn()}
      {...overrides}
    />
  );
}

describe('OnboardingWizard', () => {
  it('starts onboarding through assistant creation only', async () => {
    const onUpdateUser = vi.fn();
    renderWizard({ onUpdateUser });

    expect(screen.getByText(/Welcome to Agor/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /create your assistant/i })).toBeInTheDocument();
    expect(screen.getByText('Your assistant can help:')).toBeInTheDocument();
    expect(screen.getByText(/connect tools and credentials/i)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Agor assistant/i })).toHaveAttribute(
      'href',
      'https://agor.live/guide/assistants'
    );
    expect(screen.getByRole('link', { name: /getting started guide/i })).toBeInTheDocument();
    expect(screen.queryByText(/bring your own repository/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /create your assistant/i }));

    expect(await screen.findByText('Name Your Assistant')).toBeInTheDocument();
    expect(onUpdateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        preferences: expect.objectContaining({
          onboarding: expect.objectContaining({ path: 'assistant' }),
        }),
      })
    );
  });

  it('does not resume legacy own-repo onboarding as an alternate path', async () => {
    renderWizard({
      user: makeUser({
        preferences: { onboarding: { path: 'own-repo' } },
      } as Partial<User>),
    });

    expect(await screen.findByText('Name Your Assistant')).toBeInTheDocument();
    expect(screen.queryByText('Add Your Repository')).not.toBeInTheDocument();
  });

  it('shows recommended provider cards plus a secondary selector', async () => {
    const { baseElement } = renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /create your assistant/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));

    expect(await screen.findByText('Choose an LLM Provider')).toBeInTheDocument();
    expect(screen.getByText(/Pick what powers your assistant/i)).toBeInTheDocument();
    expect(screen.getByText('Claude Code')).toBeInTheDocument();
    expect(screen.getByText('Codex')).toBeInTheDocument();
    expect(screen.getByAltText('claude-code logo')).toBeInTheDocument();
    expect(screen.getByAltText('codex logo')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: /onboarding progress/i })).toBeInTheDocument();
    const providerOptions = Array.from(
      baseElement.querySelectorAll<HTMLInputElement>('input[name="recommended-agent"]')
    );
    const claudeOption = providerOptions.find((option) => option.value === 'claude-code');
    const codexOption = providerOptions.find((option) => option.value === 'codex');
    expect(claudeOption).toBeInstanceOf(HTMLInputElement);
    expect(claudeOption).toBeChecked();
    expect(screen.getAllByText(/ANTHROPIC_API_KEY/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText('Subscription'));
    expect(screen.getByText(/claude setup-token/)).toBeInTheDocument();
    expect(codexOption).toBeInstanceOf(HTMLInputElement);
    expect(codexOption).not.toBeChecked();
    codexOption?.focus();
    expect(codexOption).toHaveFocus();

    fireEvent.click(codexOption as HTMLInputElement);

    expect(codexOption).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /use a different provider/i })).toBeInTheDocument();
    expect(screen.queryByText('Other LLM providers')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: /use a different provider/i }));

    expect(screen.getByText('Other LLM providers')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /use a different provider/i }));
    expect(codexOption).toBeChecked();
    expect(screen.queryByText('Configure Your Agent')).not.toBeInTheDocument();
    expect(screen.getAllByText(/codex login --device-auth/).length).toBeGreaterThan(0);
  });

  it('can save a Claude subscription token during onboarding', async () => {
    const onUpdateUser = vi.fn();
    renderWizard({ onUpdateUser });

    fireEvent.click(screen.getByRole('button', { name: /create your assistant/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));

    fireEvent.click(await screen.findByText('Subscription'));
    fireEvent.change(screen.getByPlaceholderText('sk-ant-oat01-...'), {
      target: { value: 'sk-ant-oat01-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /save & continue/i }));

    expect(onUpdateUser).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        agentic_tools: {
          'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-test' },
        },
      })
    );
  });

  it('detects an existing Cursor credential when selecting Cursor', async () => {
    renderWizard({
      user: makeUser({
        agentic_tools: {
          cursor: { CURSOR_API_KEY: true },
        },
      } as Partial<User>),
    });

    fireEvent.click(screen.getByRole('button', { name: /create your assistant/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^continue$/i }));
    fireEvent.click(await screen.findByRole('checkbox', { name: /use a different provider/i }));
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(await screen.findByText('Cursor SDK (Beta)'));

    expect(await screen.findByText('Cursor SDK is configured')).toBeInTheDocument();
  });
});
