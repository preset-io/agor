import type { User } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agorStore } from '../../store/agorStore';
import { OnboardingBanners } from './OnboardingBanners';

const USER = {
  user_id: 'browser-user',
  onboarding_completed: true,
  primary_agentic_tool: 'claude-code',
  agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: true } },
  agentic_auth_methods: { 'claude-code': 'api_key' },
} as User;

beforeEach(() => {
  agorStore.getState().reset();
  agorStore.getState().setAgenticToolSettings([]);
  window.localStorage.clear();
});

afterEach(cleanup);

describe('OnboardingBanners real-browser UX', () => {
  it('keeps the agent-specific warning and accessible snooze usable at every viewport', async () => {
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <OnboardingBanners
          user={USER}
          mcpServerCount={1}
          gatewayChannelCount={0}
          integrationsHydrated
          canManageMcp={false}
          onOpenUserSettings={vi.fn()}
          onOpenWorkspaceSettings={vi.fn()}
          onOpenCatalog={vi.fn()}
          onCheckAuth={vi.fn(async () => ({
            status: 'unauthenticated',
            authenticated: false,
            method: 'api-key',
          }))}
          credentialVersion={0}
          connectionReady
        />
      </ConfigProvider>
    );

    expect(await screen.findByText(/Claude Code rejected the configured credential/)).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    expect(screen.getByRole('button', { name: 'Review Claude Code settings' })).toBeVisible();
    const snooze = screen.getByRole('button', {
      name: 'Snooze Claude Code warning for 24 hours',
    });
    snooze.focus();
    expect(snooze).toHaveFocus();
    fireEvent.click(snooze);
    expect(screen.queryByText(/Claude Code rejected/)).not.toBeInTheDocument();
  });
});
