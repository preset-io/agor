import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { OnboardingBanners, type OnboardingBannersProps } from './OnboardingBanners';

const onboardedUser = (userId: string, overrides: Partial<User> = {}): User => ({
  user_id: userId as User['user_id'],
  email: 'test@example.com',
  role: 'member',
  onboarding_completed: true,
  must_change_password: false,
  created_at: new Date(0),
  ...overrides,
});

const result = (status: AuthCheckResult['status']): AuthCheckResult => ({
  status,
  authenticated: status === 'authenticated',
  method: 'none',
});

const baseProps = (over: Partial<OnboardingBannersProps>): OnboardingBannersProps => ({
  user: onboardedUser('user-1'),
  mcpServerCount: 1,
  gatewayChannelCount: 0,
  integrationsHydrated: true,
  canManageMcp: false,
  onOpenUserSettings: vi.fn(),
  onOpenWorkspaceSettings: vi.fn(),
  onCheckAuth: vi.fn(async () => result('unauthenticated')),
  credentialVersion: 0,
  connectionReady: true,
  ...over,
});

describe('OnboardingBanners browser-local opt-outs', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    agorStore.getState().setAgenticToolSettings([]);
    window.localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('keeps an explicit opt-out through same-presence workspace rotations', async () => {
    const setting = (revision: number) => ({
      tool: 'claude-code' as const,
      revision,
      deployment_available: true,
      enabled: true,
      resolution_policy: 'tenant_preferred' as const,
      inline_configuration_allowed: true,
      connection: { ANTHROPIC_AUTH_TOKEN: { configured: true } },
    });
    act(() => agorStore.getState().setAgenticToolSettings([setting(1)]));
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    fireEvent.click(
      await screen.findByRole('button', { name: "Don't remind me about Claude Code" })
    );
    act(() => agorStore.getState().upsertAgenticToolSetting(setting(2)));
    await act(async () => {});
    expect(onCheckAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('persists a dismissal per user and tool across a reload (no 24-hour resurface)', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({ onCheckAuth });
    const first = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: "Don't remind me about Claude Code" })
    );
    await waitFor(() => expect(screen.queryByText(/Claude Code isn't connected/)).toBeNull());
    first.unmount();

    // A fresh mount (page reload) with the same still-broken credential keeps the
    // warning hidden — the dismissal is durable, not a 24-hour snooze.
    const second = render(<OnboardingBanners {...props} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalled());
    expect(screen.queryByText(/Claude Code isn't connected/)).not.toBeInTheDocument();
    second.unmount();
  });

  it('does not transfer a dismissed warning across logout or user switch', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({ onCheckAuth });
    const { rerender } = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Don't remind me about Claude Code/ })
    );
    rerender(<OnboardingBanners {...props} user={null} />);
    expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument();

    rerender(<OnboardingBanners {...props} user={onboardedUser('user-2')} />);
    expect(await screen.findByText(/Claude Code isn't connected/)).toBeVisible();
  });

  it('keeps a dismissed warning hidden when an unrelated tool credential is saved', async () => {
    // An advisory opt-out is independent of credential mutations.
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({
      user: onboardedUser('user-1', {
        agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      }),
      onCheckAuth,
    });
    const { rerender } = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Don't remind me about Claude Code/ })
    );
    await waitFor(() => expect(screen.queryByText(/Claude Code rejected/)).toBeNull());

    rerender(<OnboardingBanners {...props} credentialVersion={1} />);
    await act(async () => {});
    expect(onCheckAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Claude Code rejected/)).not.toBeInTheDocument();
  });

  it('keeps the opt-out even after this tool changes auth method or recovers', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({ onCheckAuth });
    const { rerender } = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: "Don't remind me about Claude Code" })
    );
    onCheckAuth.mockResolvedValue(result('authenticated'));
    rerender(
      <OnboardingBanners
        {...props}
        credentialVersion={1}
        user={onboardedUser('user-1', { agentic_auth_methods: { 'claude-code': 'subscription' } })}
      />
    );
    await act(async () => {});
    expect(onCheckAuth).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('syncs cross-tab dismissal and starts a fresh probe before showing a cleared reminder', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await screen.findByText(/Claude Code isn't connected/);
    const key = `agor:onboarding:v3:${'user-1'}:claude-code:dismissed`;
    window.localStorage.setItem(key, 'true');
    act(() =>
      window.dispatchEvent(new StorageEvent('storage', { key, storageArea: window.localStorage }))
    );
    expect(screen.queryByRole('status')).toBeNull();

    let settle!: (value: AuthCheckResult) => void;
    onCheckAuth.mockImplementation(
      () =>
        new Promise((resolve) => {
          settle = resolve;
        })
    );
    window.localStorage.clear();
    act(() =>
      window.dispatchEvent(
        new StorageEvent('storage', { key: null, storageArea: window.localStorage })
      )
    );
    expect(screen.queryByRole('status')).toBeNull();
    expect(onCheckAuth).toHaveBeenCalledTimes(2);
    await act(async () => settle(result('authenticated')));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not probe credentialed alternatives or make claims about all AI', async () => {
    const onCheckAuth = vi.fn(async (tool: AgenticToolName) =>
      result(tool === 'codex' ? 'authenticated' : 'unauthenticated')
    );
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            agentic_tools: {
              'claude-code': { ANTHROPIC_API_KEY: true },
              codex: { OPENAI_API_KEY: true },
            },
          }),
          onCheckAuth,
        })}
      />
    );
    expect(
      await screen.findByText('Claude Code rejected the configured credential.')
    ).toBeVisible();
    expect(onCheckAuth.mock.calls).toEqual([['claude-code']]);
    expect(screen.queryByText(/Codex|all AI|sessions will fail|unaffected/)).toBeNull();
  });

  it('shows only the selected tool rejection when several tools have stored keys', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            primary_agentic_tool: 'claude-code',
            agentic_tools: {
              'claude-code': { ANTHROPIC_API_KEY: true },
              codex: { OPENAI_API_KEY: true },
            },
            agentic_auth_methods: { 'claude-code': 'api_key' },
          }),
          onCheckAuth,
        })}
      />
    );

    expect(await screen.findByText(/Claude Code rejected the configured credential/)).toBeVisible();
    expect(screen.queryByText(/is working/)).not.toBeInTheDocument();
  });

  it('persists the integrations "Maybe later" dismissal across a reload', async () => {
    const props = baseProps({
      mcpServerCount: 0,
      canManageMcp: true,
      onCheckAuth: async () => result('authenticated'),
    });
    const first = render(<OnboardingBanners {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Maybe later' }));
    await waitFor(() => expect(screen.queryByText(/Connect tools to let your AI/)).toBeNull());
    expect(
      Object.keys(window.localStorage).some((key) => key.endsWith(':integrations-dismissed'))
    ).toBe(true);
    first.unmount();

    const second = render(<OnboardingBanners {...props} />);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText(/Connect tools to let your AI/)).not.toBeInTheDocument();
    second.unmount();
  });

  it('gives a member a durable dismiss for a workspace-managed broken tool', async () => {
    agorStore.getState().setAgenticToolSettings([
      {
        tool: 'claude-code',
        deployment_available: true,
        enabled: true,
        resolution_policy: 'tenant_preferred',
        inline_configuration_allowed: true,
        connection: { ANTHROPIC_API_KEY: { configured: true } },
      },
    ]);
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({
      user: onboardedUser('member-1', { role: 'member' }),
      onCheckAuth,
    });
    const first = render(<OnboardingBanners {...props} />);
    // No CTA to fix it, but a real dismiss.
    expect(await screen.findByText(/rejected the workspace-managed credential/)).toBeVisible();
    expect(screen.queryByRole('button', { name: /Review Claude Code settings/ })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: "Don't remind me about Claude Code" }));
    await waitFor(() =>
      expect(screen.queryByText(/rejected the workspace-managed credential/)).toBeNull()
    );
    first.unmount();

    const second = render(<OnboardingBanners {...props} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalled());
    expect(screen.queryByText(/rejected the workspace-managed credential/)).not.toBeInTheDocument();
    second.unmount();
  });
  it('preserves workspace opt-out through a cold policy hydration', async () => {
    const setting = {
      tool: 'claude-code' as const,
      enabled: true,
      deployment_available: true,
      revision: 7,
      resolution_policy: 'tenant_required' as const,
      inline_configuration_allowed: true,
      connection: { ANTHROPIC_API_KEY: { configured: true } },
    };
    act(() => agorStore.getState().setAgenticToolSettings([setting]));
    const props = baseProps({});
    const first = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: "Don't remind me about Claude Code" })
    );
    first.unmount();
    act(() => agorStore.getState().reset());
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    render(<OnboardingBanners {...props} onCheckAuth={onCheckAuth} />);
    act(() => agorStore.getState().setAgenticToolSettings([setting]));
    await act(async () => {});
    expect(onCheckAuth).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each(['user', 'tool'] as const)(
    'does not borrow a warning opt-out after a %s switch',
    async (scope) => {
      const props = baseProps({});
      const view = render(<OnboardingBanners {...props} />);
      fireEvent.click(
        await screen.findByRole('button', { name: "Don't remind me about Claude Code" })
      );
      const nextUser = onboardedUser(scope === 'user' ? 'user-2' : 'user-1', {
        primary_agentic_tool: scope === 'tool' ? 'codex' : 'claude-code',
      });
      view.rerender(<OnboardingBanners {...props} user={nextUser} />);
      expect(await screen.findByRole('status')).toHaveTextContent(
        scope === 'tool' ? "Codex isn't connected" : "Claude Code isn't connected"
      );
      view.rerender(<OnboardingBanners {...props} />);
      expect(screen.queryByRole('status')).toBeNull();
    }
  );

  it('does not borrow Maybe later from a different workspace user without remounting the shell', async () => {
    const props = baseProps({
      mcpServerCount: 0,
      canManageMcp: true,
      onCheckAuth: vi.fn(async () => result('authenticated')),
    });
    const view = render(<OnboardingBanners {...props} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Maybe later' }));
    const nextUser = onboardedUser('user-2');
    view.rerender(<OnboardingBanners {...props} user={nextUser} />);
    expect(await screen.findByRole('button', { name: 'Maybe later' })).toBeVisible();
    view.rerender(<OnboardingBanners {...props} />);
    await act(async () => {});
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('drops an old authority response even when the user and callback are unchanged', async () => {
    let settleOld!: (value: AuthCheckResult) => void;
    const onCheckAuth = vi
      .fn<(tool: AgenticToolName) => Promise<AuthCheckResult>>()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            settleOld = resolve;
          })
      )
      .mockResolvedValue(result('authenticated'));
    const props = baseProps({ onCheckAuth, authenticationGeneration: 1 });
    const view = render(<OnboardingBanners {...props} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(1));
    view.rerender(<OnboardingBanners {...props} authenticationGeneration={2} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(2));
    await act(async () => settleOld(result('unauthenticated')));
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('does not show integrations while disconnected or while policy is loading, even with a stored key', async () => {
    const props = baseProps({
      user: onboardedUser('user-1', {
        agentic_tools: {
          'claude-code': { ANTHROPIC_API_KEY: true },
        },
      }),
      mcpServerCount: 0,
      canManageMcp: true,
      onCheckAuth: vi.fn(async () => result('authenticated')),
    });
    const view = render(<OnboardingBanners {...props} connectionReady={false} />);
    expect(screen.queryByRole('status')).toBeNull();
    act(() => agorStore.getState().reset());
    view.rerender(<OnboardingBanners {...props} />);
    await act(async () => {});
    expect(props.onCheckAuth).not.toHaveBeenCalled();
    expect(screen.queryByRole('status')).toBeNull();
  });

  it.each(['unavailable', 'quota', 'malformed'] as const)(
    'keeps dismissal usable with %s storage',
    async (failure) => {
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      if (failure === 'unavailable')
        vi.spyOn(window, 'localStorage', 'get').mockImplementation(() => {
          throw new Error('blocked');
        });
      if (failure === 'quota')
        vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
          throw new Error('quota');
        });
      if (failure === 'malformed')
        window.localStorage.setItem(
          `agor:onboarding:v3:${'user-1'}:claude-code:dismissed`,
          '"not-a-boolean"'
        );
      render(<OnboardingBanners {...baseProps({})} />);
      fireEvent.click(
        await screen.findByRole('button', { name: "Don't remind me about Claude Code" })
      );
      expect(screen.queryByRole('status')).toBeNull();
    }
  );
});
