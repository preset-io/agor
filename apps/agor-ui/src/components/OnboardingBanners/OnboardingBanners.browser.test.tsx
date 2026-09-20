import type { User } from '@agor-live/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
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
            status: 'unauthenticated' as const,
            authenticated: false,
            method: 'api-key' as const,
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

  it('stacks the message above the actions on a narrow viewport (no per-word tower)', async () => {
    // Every configured browser instance is < 1024px, so the banner is mobile.
    render(
      <ConfigProvider theme={{ token: { motion: false } }}>
        <div style={{ width: 360 }}>
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
              status: 'unauthenticated' as const,
              authenticated: false,
              method: 'api-key' as const,
            }))}
            credentialVersion={0}
            connectionReady
          />
        </div>
      </ConfigProvider>
    );

    const message = await screen.findByText(/Claude Code rejected the configured credential/);
    const button = screen.getByRole('button', { name: 'Review Claude Code settings' });
    // Message spans a readable width (not squished to a ~60px per-word column).
    expect(message.getBoundingClientRect().width).toBeGreaterThan(200);
    // The action sits below the message, not beside it.
    expect(button.getBoundingClientRect().top).toBeGreaterThan(
      message.getBoundingClientRect().bottom - 2
    );
  });
});

it('keeps Maybe later dismissed when the mobile banner remounts', async () => {
  const banner = (
    <OnboardingBanners
      user={USER}
      mcpServerCount={0}
      gatewayChannelCount={0}
      integrationsHydrated
      canManageMcp
      connectionReady
      credentialVersion={0}
      onOpenUserSettings={vi.fn()}
      onOpenWorkspaceSettings={vi.fn()}
      onCheckAuth={async () => ({
        status: 'authenticated',
        authenticated: true,
        method: 'api-key',
      })}
    />
  );
  const first = render(banner);
  const button = await screen.findByRole('button', { name: 'Maybe later' });
  expect(button).toHaveAttribute('title', 'Hide this reminder for 24 hours');
  button.focus();
  await userEvent.keyboard('{Enter}');
  expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
  first.unmount();
  render(banner);
  expect(screen.queryByText(/Connect Slack/)).not.toBeInTheDocument();
});
