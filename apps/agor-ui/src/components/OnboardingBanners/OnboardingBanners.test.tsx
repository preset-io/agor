import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
  ...over,
});

describe('OnboardingBanners probe effect', () => {
  beforeEach(() => agorStore.getState().reset());

  it('shows "No AI" once every probe positively reports unauthenticated', async () => {
    render(
      <OnboardingBanners {...baseProps({ onCheckAuth: async () => result('unauthenticated') })} />
    );
    await waitFor(() => expect(screen.getByText(/No AI connected/)).toBeInTheDocument());
  });

  it('shows no amber banner when the probe confirms authenticated', async () => {
    render(
      <OnboardingBanners {...baseProps({ onCheckAuth: async () => result('authenticated') })} />
    );
    // Give the effect a chance to resolve, then assert nothing scary rendered.
    await waitFor(() => expect(screen.queryByText(/No AI connected/)).not.toBeInTheDocument());
  });

  it('shows no amber banner when the probe throws (fail safe → Unknown)', async () => {
    const onCheckAuth = vi.fn(async () => {
      throw new Error('boom');
    });
    render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalled());
    expect(screen.queryByText(/No AI connected/)).not.toBeInTheDocument();
  });

  it('re-probes and resets state on a user-identity change', async () => {
    const onCheckAuth = vi.fn(async (_tool: AgenticToolName) => result('authenticated'));
    const { rerender } = render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledTimes(1));

    onCheckAuth.mockImplementation(async () => result('unauthenticated'));
    rerender(<OnboardingBanners {...baseProps({ user: onboardedUser('user-2'), onCheckAuth })} />);
    await waitFor(() => expect(screen.getByText(/No AI connected/)).toBeInTheDocument());
  });

  it('re-probes and clears the banner when a Codex subscription login lands via a user patch (no remount)', async () => {
    // The daemon device-sign-in / auth.json-import flows persist
    // agentic_auth_methods.codex server-side; it arrives as a user patch with no
    // stored key and no credentialVersion bump — the case that previously left
    // the banner stuck until a page refresh.
    const onCheckAuth = vi.fn(async () => result('unauthenticated'));
    const { rerender } = render(<OnboardingBanners {...baseProps({ onCheckAuth })} />);
    await waitFor(() => expect(screen.getByText(/No AI connected/)).toBeInTheDocument());
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
    await waitFor(() => expect(screen.queryByText(/No AI connected/)).not.toBeInTheDocument());
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

  it('treats CLAUDE_CODE_OAUTH_TOKEN in user env vars as Claude auth (probes claude-code, no banner)', async () => {
    const onCheckAuth = vi.fn(async () => result('authenticated'));
    render(
      <OnboardingBanners
        {...baseProps({
          user: onboardedUser('user-1', {
            env_vars: {
              CLAUDE_CODE_OAUTH_TOKEN: { set: true, scope: 'global', resource_id: null },
            },
          } as Partial<User>),
          onCheckAuth,
        })}
      />
    );
    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code'));
    expect(screen.queryByText(/No AI connected/)).not.toBeInTheDocument();
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

    fireEvent.click(await screen.findByRole('button', { name: 'Connect AI' }));
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
    fireEvent.click((await screen.findByText('Reconnect AI')).closest('button')!);
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
    fireEvent.click((await screen.findByText('Reconnect AI')).closest('button')!);
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
    fireEvent.click((await screen.findByText('Connect AI')).closest('button')!);
    expect(onOpenUserSettings).toHaveBeenCalledWith('codex');
  });
});
