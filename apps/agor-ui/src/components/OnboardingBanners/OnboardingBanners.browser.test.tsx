import type { User } from '@agor-live/client';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider, theme } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { userEvent } from 'vitest/browser';
import { agorStore } from '../../store/agorStore';
import { OnboardingBanners, type OnboardingBannersProps } from './OnboardingBanners';

const USER: User = {
  user_id: 'browser-user' as User['user_id'],
  email: 'browser@example.com',
  role: 'member',
  must_change_password: false,
  created_at: new Date(0),
  onboarding_completed: true,
  primary_agentic_tool: 'claude-code',
  agentic_tools: { 'claude-code': { ANTHROPIC_AUTH_TOKEN: true } },
  agentic_auth_methods: { 'claude-code': 'api_key' },
};

beforeEach(() => {
  agorStore.getState().reset();
  agorStore.getState().setAgenticToolSettings([]);
  window.localStorage.clear();
});
afterEach(cleanup);

const baseProps = (): OnboardingBannersProps => ({
  user: USER,
  mcpServerCount: 1,
  gatewayChannelCount: 0,
  integrationsHydrated: true,
  canManageMcp: false,
  onOpenUserSettings: vi.fn(),
  onOpenWorkspaceSettings: vi.fn(),
  onCheckAuth: vi.fn<OnboardingBannersProps['onCheckAuth']>(async () => ({
    status: 'unauthenticated',
    authenticated: false,
    method: 'api-key',
  })),
  credentialVersion: 0,
  connectionReady: true,
});

function expectCompactReminder() {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
  // Horizontal overflow alone previously passed a 412px-tall, word-by-word
  // phone banner. Leave room for the actual app/composer as well.
  expect(screen.getByRole('status').getBoundingClientRect().height).toBeLessThan(180);
}

describe('OnboardingBanners real-browser UX', () => {
  it.each([false, true])(
    'keeps copy, actions and persistent dismiss usable (dark=%s)',
    async (dark) => {
      const props = baseProps();
      const content = (
        <ConfigProvider
          theme={{
            algorithm: dark ? theme.darkAlgorithm : theme.defaultAlgorithm,
            token: { motion: false },
          }}
        >
          <OnboardingBanners {...props} />
        </ConfigProvider>
      );
      const first = render(content);
      expect(
        await screen.findByText('Claude Code rejected the configured credential.')
      ).toBeVisible();
      expectCompactReminder();
      const settings = screen.getByRole('button', { name: 'Review Claude Code settings' });
      if (window.innerWidth <= 320) {
        expect(settings.getBoundingClientRect().top).toBeGreaterThanOrEqual(
          screen
            .getByText('Claude Code rejected the configured credential.')
            .getBoundingClientRect().bottom
        );
      }
      act(() => settings.focus());
      await act(async () => userEvent.keyboard('{Enter}'));
      expect(props.onOpenUserSettings).toHaveBeenCalledWith('claude-code');
      await act(async () => userEvent.tab());
      const dismiss = screen.getByRole('button', { name: "Don't remind me about Claude Code" });
      expect(dismiss).toHaveFocus();
      await act(async () => userEvent.keyboard('{Enter}'));
      expect(screen.queryByRole('status')).toBeNull();
      first.unmount();
      render(content);
      expect(screen.queryByRole('status')).toBeNull();
      expect(props.onCheckAuth).toHaveBeenCalledTimes(1);
    }
  );

  it('wraps the workspace-fallback action without narrowing the message to single words', async () => {
    agorStore.getState().setAgenticToolSettings([
      {
        tool: 'claude-code',
        deployment_available: true,
        enabled: true,
        revision: 1,
        resolution_policy: 'user_preferred',
        inline_configuration_allowed: true,
        connection: { ANTHROPIC_API_KEY: { configured: true } },
      },
    ]);
    render(
      <OnboardingBanners {...baseProps()} user={{ ...USER, role: 'member', agentic_tools: {} }} />
    );
    expect(await screen.findByText(/Add a personal credential to override/)).toBeVisible();
    expectCompactReminder();
    expect(
      screen.getByRole('button', { name: 'Add personal Claude Code credential' })
    ).toBeVisible();
  });

  it('keeps both integrations actions usable on small screens', async () => {
    const props = baseProps();
    render(
      <OnboardingBanners
        {...props}
        mcpServerCount={0}
        canManageMcp
        onCheckAuth={async () => ({
          status: 'authenticated',
          authenticated: true,
          method: 'api-key',
        })}
      />
    );
    expect(await screen.findByRole('button', { name: 'Browse the catalog' })).toBeVisible();
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth + 1);
    act(() => screen.getByRole('button', { name: 'Maybe later' }).focus());
    await act(async () => userEvent.keyboard(' '));
    expect(screen.queryByRole('button', { name: 'Maybe later' })).toBeNull();
  });

  it('replaces a rejected credential verdict only after the new probe settles', async () => {
    const props = baseProps();
    const view = render(<OnboardingBanners {...props} />);
    expect(await screen.findByText(/rejected the configured credential/)).toBeVisible();
    let settle!: (value: Awaited<ReturnType<OnboardingBannersProps['onCheckAuth']>>) => void;
    const onCheckAuth: OnboardingBannersProps['onCheckAuth'] = () =>
      new Promise((resolve) => {
        settle = resolve;
      });
    view.rerender(<OnboardingBanners {...props} credentialVersion={1} onCheckAuth={onCheckAuth} />);
    expect(screen.queryByRole('status')).toBeNull();
    await act(async () =>
      settle({ status: 'authenticated', authenticated: true, method: 'api-key' })
    );
    expect(screen.queryByRole('status')).toBeNull();
    view.rerender(<OnboardingBanners {...props} credentialVersion={2} />);
    expect(await screen.findByText(/rejected the configured credential/)).toBeVisible();
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
