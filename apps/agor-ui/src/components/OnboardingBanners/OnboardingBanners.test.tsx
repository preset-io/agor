import type { User } from '@agor-live/client';
import { render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { OnboardingBanners } from './OnboardingBanners';

function makeUser(overrides: Partial<User> = {}): User {
  return {
    user_id: 'user-1',
    email: 'user@example.com',
    name: 'User',
    role: 'member',
    onboarding_completed: true,
    ...overrides,
  } as User;
}

describe('OnboardingBanners', () => {
  it('treats CLAUDE_CODE_OAUTH_TOKEN in user env vars as Claude auth', async () => {
    const onCheckAuth = vi.fn(async () => ({ authenticated: true, method: 'oauth' as const }));

    render(
      <OnboardingBanners
        user={makeUser({
          env_vars: {
            CLAUDE_CODE_OAUTH_TOKEN: { set: true, scope: 'global', resource_id: null },
          },
        })}
        mcpServerCount={1}
        canManageMcp={false}
        onOpenUserSettings={vi.fn()}
        onOpenWorkspaceSettings={vi.fn()}
        onCheckAuth={onCheckAuth}
      />
    );

    await waitFor(() => expect(onCheckAuth).toHaveBeenCalledWith('claude-code'));
    expect(screen.queryByText(/connect an ai provider/i)).not.toBeInTheDocument();
  });
});
