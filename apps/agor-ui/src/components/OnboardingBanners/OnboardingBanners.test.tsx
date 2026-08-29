import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { OnboardingBanners, type OnboardingBannersProps } from './OnboardingBanners';

const onboardedUser = (userId: string, overrides: Partial<User> = {}): User =>
  ({ user_id: userId, onboarding_completed: true, ...overrides }) as User;

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

describe('OnboardingBanners probe effect', () => {
  beforeEach(() => {
    agorStore.getState().reset();
    agorStore.getState().setAgenticToolSettings([]);
    window.localStorage.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('shows an agent-specific missing warning on a positive unauthenticated result', async () => {
    render(
      <OnboardingBanners {...baseProps({ onCheckAuth: async () => result('unauthenticated') })} />
    );
    await waitFor(() =>
      expect(screen.getByText(/Claude Code isn't connected/)).toBeInTheDocument()
    );
  });

  it('shows no amber banner when the probe confirms authenticated', async () => {
    render(
      <OnboardingBanners {...baseProps({ onCheckAuth: async () => result('authenticated') })} />
    );
    // Give the effect a chance to resolve, then assert nothing scary rendered.
    await waitFor(() => expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument());
  });

  it('shows no amber banner when the probe throws (fail safe → Unknown)', async () => {
    const onCheckAuth = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalled());
    expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument();
  });

  it('stays Unknown until workspace agent policy finishes hydrating', async () => {
    agorStore.getState().reset();
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);

    expect(onCheckAuth).not.toHaveBeenCalled();
    expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument();

    act(() => agorStore.getState().setAgenticToolSettings([]));
    expect(await screen.findByText(/Claude Code isn't connected/)).toBeVisible();
  });

  it('does not call a disabled tool a credential failure when no agent is available', () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const disabled = ['claude-code', 'codex', 'gemini', 'copilot', 'cursor', 'opencode'].map(
      (tool) => ({
        tool,
        deployment_available: true,
        enabled: false,
        resolution_policy: 'user_preferred',
        inline_configuration_allowed: true,
        connection: {},
      })
    );
    act(() => agorStore.getState().setAgenticToolSettings(disabled as never));

    render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);

    expect(onCheckAuth).not.toHaveBeenCalled();
    expect(screen.queryByText(/isn't connected|rejected the configured credential/)).toBeNull();
  });

  it('re-probes and resets state on a user-identity change', async () => {
    const onCheckAuth = vi.fn(async (_tool: AgenticToolName) => result('authenticated'));
    const { rerender } = render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(1));

    onCheckAuth.mockImplementation(async () => result('unauthenticated'));
    rerender(<OnboardingBanners {...baseProps({ user: onboardedUser('user-2'), onCheckAuth })} />);
    await waitFor(() =>
      expect(screen.getByText(/Claude Code isn't connected/)).toBeInTheDocument()
    );
  });

  it('re-probes and clears the banner when a Codex subscription login lands via a user patch (no remount)', async () => {
    // The daemon device-sign-in / auth.json-import flows persist
    // agentic_auth_methods.codex server-side; it arrives as a user patch with no
    // stored key and no credentialVersion bump — the case that previously left
    // the banner stuck until a page refresh.
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const { rerender } = render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await waitFor(() =>
      expect(screen.getByText(/Claude Code isn't connected/)).toBeInTheDocument()
    );
    const callsBefore = onCheckAuth.mock.calls.length;

    onCheckAuth.mockImplementation(async () => result('authenticated'));
    rerender(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            agentic_auth_methods: { codex: 'subscription' },
          } as Partial<User>),
          onCheckAuth,
        })}
      />
    );

    // Same identity → same component instance (no remount); the method-marker
    // dep change re-fires the probe, which now clears the banner.
    await waitFor(() => expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument());
    expect(onCheckAuth.mock.calls.length).toBeGreaterThan(callsBefore);
  });

  it('does not re-probe on an unrelated user-record patch (e.g. a name edit)', async () => {
    const onCheckAuth = vi.fn(async () => result('authenticated'));
    // Seed a codex method so the effect's method deps are non-empty in BOTH
    // renders (each a FRESH object). This pins the object-identity hazard: the
    // deps must be the derived primitive, not `user.agentic_auth_methods` — the
    // latter is a new object on every patch and would spuriously re-fire.
    const authMethods = { codex: 'subscription' } as const;
    const { rerender } = render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            agentic_auth_methods: { ...authMethods },
          } as Partial<User>),
          onCheckAuth,
        })}
      />
    );
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(1));

    // A field that touches neither identity, stored keys, nor auth methods must
    // NOT spawn another ~5–10s probe — even though the whole user object (and its
    // agentic_auth_methods) is a fresh reference from the patch.
    rerender(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            name: 'Renamed',
            agentic_auth_methods: { ...authMethods },
          } as Partial<User>),
          onCheckAuth,
        })}
      />
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(onCheckAuth).toHaveBeenCalledTimes(1);
  });

  it('treats provider-scoped CLAUDE_CODE_OAUTH_TOKEN as Claude auth (probes claude-code, no banner)', async () => {
    const onCheckAuth = vi.fn(async () => result('authenticated'));
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            agentic_tools: {
              'claude-code': { CLAUDE_CODE_OAUTH_TOKEN: true },
            },
            agentic_auth_methods: { 'claude-code': 'subscription' },
          } as Partial<User>),
          onCheckAuth,
        })}
      />
    );
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code'));
    expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument();
  });

  it('uses the standard alert action to open AI settings', async () => {
    const onOpenUserSettings = vi.fn();
    render(
      <OnboardingBanners
        {...baseProps({
          onCheckAuth: async () => result('unauthenticated'),
          onOpenUserSettings,
        })}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Open Claude Code settings' }));
    expect(onOpenUserSettings).toHaveBeenCalledWith('claude-code');
  });

  it('dismisses the integrations alert', async () => {
    render(
      <OnboardingBanners
        {...baseProps({
          mcpServerCount: 0,
          canManageMcp: true,
          onCheckAuth: async () => result('authenticated'),
        })}
      />
    );

    fireEvent.click(await screen.findByRole('button', { name: 'Maybe later' }));
    expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
  });

  it('routes tenant-preferred credential failures to workspace agentic-tool settings', async () => {
    agorStore.getState().setAgenticToolSettings([
      {
        tool: 'claude-code',
        enabled: true,
        resolution_policy: 'tenant_preferred',
        inline_configuration_allowed: true,
        connection: { ANTHROPIC_API_KEY: { configured: true } },
      },
    ]);
    const onOpenUserSettings = vi.fn();
    const onOpenWorkspaceSettings = vi.fn();
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('admin-1', { role: 'admin' }),
          onOpenUserSettings,
          onOpenWorkspaceSettings,
          onCheckAuth: async () => result('unauthenticated'),
        })}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review Claude Code settings' }));
    expect(onOpenWorkspaceSettings).toHaveBeenCalledWith('agentic-tools');
    expect(onOpenUserSettings).not.toHaveBeenCalled();
  });

  it('routes members to user settings when tenant credentials are preferred', async () => {
    agorStore.getState().setAgenticToolSettings([
      {
        tool: 'claude-code',
        enabled: true,
        resolution_policy: 'tenant_preferred',
        inline_configuration_allowed: true,
        connection: { ANTHROPIC_API_KEY: { configured: true } },
      },
    ]);
    const onOpenUserSettings = vi.fn();
    const onOpenWorkspaceSettings = vi.fn();
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('member-1', { role: 'member' }),
          onOpenUserSettings,
          onOpenWorkspaceSettings,
          onCheckAuth: async () => result('unauthenticated'),
        })}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Review Claude Code settings' }));
    expect(onOpenUserSettings).toHaveBeenCalledWith('claude-code');
    expect(onOpenWorkspaceSettings).not.toHaveBeenCalled();
  });

  it('routes user-preferred credential failures to the selected user tool tab', async () => {
    agorStore.getState().setAgenticToolSettings([
      {
        tool: 'claude-code',
        enabled: false,
        resolution_policy: 'user_preferred',
        inline_configuration_allowed: true,
        connection: {},
      },
      {
        tool: 'codex',
        enabled: true,
        resolution_policy: 'user_required',
        inline_configuration_allowed: true,
        connection: {},
      },
    ]);
    const onOpenUserSettings = vi.fn();
    render(
      <OnboardingBanners
        {...baseProps({ onOpenUserSettings, onCheckAuth: async () => result('unauthenticated') })}
      />
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open Codex settings' }));
    expect(onOpenUserSettings).toHaveBeenCalledWith('codex');
  });

  it('renders Claude bearer-token rejection as Claude-only and never exposes secret data', async () => {
    const syntheticSecret = 'synthetic-secret-must-not-render';
    const onCheckAuth = vi.fn(async () => ({
      ...result('unauthenticated'),
      hint: syntheticSecret,
    }));
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            primary_agentic_tool: 'claude-code',
            agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: true } },
            agentic_auth_methods: { 'claude-code': 'api_key' },
          }),
          onCheckAuth,
        })}
      />
    );

    expect(await screen.findByText(/Claude Code rejected the configured credential/)).toBeVisible();
    expect(screen.getByText(/New Claude Code sessions will fail/)).toBeVisible();
    expect(screen.queryByText(/Codex rejected/)).not.toBeInTheDocument();
    expect(document.body).not.toHaveTextContent(syntheticSecret);
  });

  it('does not probe or surface another-agent-only failure', async () => {
    const onCheckAuth = vi.fn(async (tool: AgenticToolName) =>
      result(tool === 'claude-code' ? 'authenticated' : 'unauthenticated')
    );
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', { primary_agentic_tool: 'claude-code' }),
          onCheckAuth,
        })}
      />
    );

    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(1));
    expect(onCheckAuth).toHaveBeenCalledWith('claude-code');
    expect(screen.queryByText(/rejected the configured credential/)).not.toBeInTheDocument();
  });

  it('resets to Unknown while disconnected, then clears a stale warning after reconnect success', async () => {
    const onCheckAuth = vi
      .fn<(tool: AgenticToolName) => Promise<AuthCheckResult>>()
      .mockResolvedValueOnce(result('unauthenticated'))
      .mockResolvedValueOnce(result('authenticated'));
    const props = baseProps({ onCheckAuth });
    const { rerender } = render(<OnboardingBanners {...props} />);
    await screen.findByText(/Claude Code isn't connected/);

    rerender(<OnboardingBanners {...props} connectionReady={false} />);
    await waitFor(() => expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument());
    rerender(<OnboardingBanners {...props} connectionReady />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument();
  });

  it('shows the warning again when a reconnect positively confirms failure', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({ onCheckAuth, connectionReady: false });
    const { rerender } = render(<OnboardingBanners {...props} />);
    expect(onCheckAuth).not.toHaveBeenCalled();

    rerender(<OnboardingBanners {...props} connectionReady />);
    expect(await screen.findByText(/Claude Code isn't connected/)).toBeVisible();
  });

  it('re-probes a same-field credential rotation delivered by realtime updated_at', async () => {
    const onCheckAuth = vi
      .fn<(tool: AgenticToolName) => Promise<AuthCheckResult>>()
      .mockResolvedValueOnce(result('unauthenticated'))
      .mockResolvedValueOnce(result('authenticated'));
    const credentialState = {
      primary_agentic_tool: 'claude-code' as const,
      agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: true } },
      agentic_auth_methods: { 'claude-code': 'api_key' as const },
    };
    const { rerender } = render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            ...credentialState,
            updated_at: new Date('2026-08-29T10:00:00Z'),
          }),
          onCheckAuth,
        })}
      />
    );
    await screen.findByText(/Claude Code rejected/);

    rerender(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            ...credentialState,
            updated_at: new Date('2026-08-29T10:01:00Z'),
          }),
          onCheckAuth,
        })}
      />
    );
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(2));
    expect(screen.queryByText(/Claude Code rejected/)).not.toBeInTheDocument();
  });

  it('persists an accessible 24-hour snooze per user and tool, then reminds again', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const start = new Date('2026-08-29T12:00:00Z');
    vi.setSystemTime(start);
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({ onCheckAuth });
    const first = render(<OnboardingBanners {...props} />);
    const close = await screen.findByRole('button', {
      name: 'Snooze Claude Code warning for 24 hours',
    });
    fireEvent.click(close);
    await waitFor(() => expect(screen.queryByText(/Claude Code isn't connected/)).toBeNull());
    first.unmount();

    const second = render(<OnboardingBanners {...props} />);
    await waitFor(() => expect(screen.queryByText(/Claude Code isn't connected/)).toBeNull());
    const callsBeforeReminder = onCheckAuth.mock.calls.length;

    await act(() => vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 1));
    expect(onCheckAuth.mock.calls.length).toBeGreaterThan(callsBeforeReminder);
    expect(await screen.findByText(/Claude Code isn't connected/)).toBeVisible();
    second.unmount();
    vi.useRealTimers();
  });

  it('does not transfer a dismissed warning across logout or user switch', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({ onCheckAuth });
    const { rerender } = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Snooze Claude Code warning for 24 hours/ })
    );
    rerender(<OnboardingBanners {...props} user={null} />);
    expect(screen.queryByText(/isn't connected/)).not.toBeInTheDocument();

    rerender(<OnboardingBanners {...props} user={onboardedUser('user-2')} />);
    expect(await screen.findByText(/Claude Code isn't connected/)).toBeVisible();
  });

  it('clears a snooze after a local credential save so reconnect failure is visible', async () => {
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const props = baseProps({
      user: onboardedUser('user-1', {
        agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      }),
      onCheckAuth,
    });
    const { rerender } = render(<OnboardingBanners {...props} />);
    fireEvent.click(
      await screen.findByRole('button', { name: /Snooze Claude Code warning for 24 hours/ })
    );
    await waitFor(() => expect(screen.queryByText(/Claude Code rejected/)).toBeNull());

    rerender(<OnboardingBanners {...props} credentialVersion={1} />);
    expect(await screen.findByText(/Claude Code rejected/)).toBeVisible();
  });
});
