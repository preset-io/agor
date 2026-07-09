import type { AgenticToolName, AuthCheckResult, User } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingBanners, type OnboardingBannersProps } from './OnboardingBanners';

const onboardedUser = (userId: string): User =>
  ({ user_id: userId, onboarding_completed: true }) as User;

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
});
