import type { User } from '@agor-live/client';
import { cleanup, render, screen } from '@testing-library/react';
import { App as AntApp, theme as antdTheme, ConfigProvider } from 'antd';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { UserSettingsModal } from './UserSettingsModal';

function makeUser(overrides: Partial<User>): User {
  return {
    user_id: 'browser-user',
    email: 'browser@example.test',
    name: 'Browser User',
    role: 'member',
    default_agentic_config: {},
    ...overrides,
  } as User;
}

function renderModal(user: User) {
  return render(
    <ConfigProvider theme={{ algorithm: antdTheme.darkAlgorithm, token: { motion: false } }}>
      <AntApp>
        <UserSettingsModal
          open
          onClose={vi.fn()}
          user={user}
          currentUser={user}
          client={null}
          onUpdate={vi.fn()}
          initialTab="claude-code"
        />
      </AntApp>
    </ConfigProvider>
  );
}

beforeEach(() => {
  __setAuthConfigForTests({ requireAuth: true });
  agorStore.getState().setAgenticToolSettings([]);
});

afterEach(() => {
  cleanup();
  __resetAuthConfigForTests();
  agorStore.getState().setAgenticToolSettings([]);
});

describe('Claude credential-source display (real browser)', () => {
  it('shows explicit none as disconnected even when an API key remains stored', async () => {
    renderModal(
      makeUser({
        agentic_auth_methods: { 'claude-code': 'api_key' },
        agentic_credential_sources: { 'claude-code': 'none' },
        agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
      })
    );

    const heading = await screen.findByRole('heading', { name: 'Claude Code' });
    expect(heading.parentElement).toHaveTextContent('Not connected');
  });

  it('shows an explicit managed file as connected without an env token', async () => {
    renderModal(
      makeUser({
        agentic_auth_methods: { 'claude-code': 'subscription' },
        agentic_credential_sources: { 'claude-code': 'managed_file' },
      })
    );

    const heading = await screen.findByRole('heading', { name: 'Claude Code' });
    expect(heading.parentElement).toHaveTextContent('Connected');
  });
});
