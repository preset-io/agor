import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
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
});
