import type { AgorClient, UpdateUserInput, User } from '@agor-live/client';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntApp, theme as antdTheme, ConfigProvider } from 'antd';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { __resetAuthConfigForTests, __setAuthConfigForTests } from '../../hooks/useAuthConfig';
import { agorStore } from '../../store/agorStore';
import { SharedUserSettingsModal } from '../../surfaces/SharedUserSettingsModal';
import { UserSettingsModal } from './UserSettingsModal';

function makeUser(overrides: Partial<User> = {}): User {
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

describe('Own settings persistence (real browser)', () => {
  it('keeps clear/save results after reopening and cannot close during a pending clear', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    const initialUser = makeUser({
      agentic_auth_methods: { 'claude-code': 'api_key' },
      agentic_credential_sources: { 'claude-code': 'api_key' },
      agentic_tools: { 'claude-code': { ANTHROPIC_API_KEY: true } },
    });
    let savedUser = initialUser;
    const patch = vi.fn(async (_id: string, updates: UpdateUserInput) => {
      const value = updates.agentic_tools?.['claude-code']?.ANTHROPIC_API_KEY;
      if (value === null) await pending;
      savedUser = {
        ...savedUser,
        agentic_tools: value === null ? {} : { 'claude-code': { ANTHROPIC_API_KEY: true } },
        agentic_credential_sources: { 'claude-code': value === null ? 'none' : 'api_key' },
      };
    });
    const refresh = vi.fn();
    function Harness() {
      const [user, setUser] = useState(initialUser);
      const [open, setOpen] = useState(true);
      return (
        <ConfigProvider theme={{ token: { motion: false } }}>
          <AntApp>
            <button type="button" onClick={() => setOpen(true)}>
              Reopen settings
            </button>
            <SharedUserSettingsModal
              open={open}
              user={user}
              client={null}
              initialTab="claude-code"
              onClose={() => setOpen(false)}
              onUpdateUser={patch}
              onRefreshCurrentUser={async (shouldApply) => {
                refresh();
                if (shouldApply()) setUser(savedUser);
              }}
            />
          </AntApp>
        </ConfigProvider>
      );
    }
    render(<Harness />);
    fireEvent.click(await screen.findByRole('button', { name: /Clear$/ }));
    await waitFor(() => expect(patch).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'Done' })).toBeDisabled();
    const close =
      screen.queryByRole('button', { name: 'Close user settings' }) ??
      screen.getByRole('button', { name: 'Close' });
    fireEvent.click(close);
    expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeVisible();
    await act(async () => {
      release();
      await pending;
    });
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(await screen.findByPlaceholderText('sk-ant-api03-...')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Claude Code' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reopen settings' }));
    await waitFor(() => expect(screen.getByPlaceholderText('sk-ant-api03-...')).toBeVisible());
    const input = screen.getByPlaceholderText('sk-ant-api03-...');
    fireEvent.change(input, { target: { value: 'review-only-dummy-key' } });
    // The API-key field is the only enabled inline Save.
    const save = screen
      .getAllByRole('button', { name: 'Save' })
      .find((button) => !(button as HTMLButtonElement).disabled);
    fireEvent.click(save!);
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByRole('button', { name: /Clear$/ })).toBeVisible());
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Claude Code' })).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Reopen settings' }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Clear$/ })).toBeVisible());
  });
});

describe('Cross-panel validation (real browser)', () => {
  it('validates inactive provider drafts before making the combined user patch', async () => {
    const user = makeUser();
    const onClose = vi.fn();
    const onUpdate = vi.fn(async (_userId: string, _updates: UpdateUserInput) => {});
    const client = {
      service: () => ({
        find: async () => [
          {
            preset_id: 'preset-a',
            name: 'Team preset',
            tool: 'claude-code',
            configuration: {},
            is_default: false,
          },
        ],
      }),
    } as unknown as AgorClient;
    const view = (currentUser: User) => (
      <ConfigProvider theme={{ token: { motion: false } }}>
        <AntApp>
          <UserSettingsModal
            open
            user={currentUser}
            currentUser={currentUser}
            client={client}
            onUpdate={onUpdate}
            onClose={onClose}
            initialTab="claude-code"
          />
        </AntApp>
      </ConfigProvider>
    );
    const rendered = render(view(user));
    fireEvent.click(await screen.findByRole('tab', { name: 'Session defaults' }));
    fireEvent.mouseDown(await screen.findByLabelText('Default for new configurations'));
    fireEvent.click(await screen.findByText('Use a specific preset'));
    await screen.findByLabelText('Preset');
    const profileMenu = screen.queryByRole('menuitem', { name: /Profile/i });
    if (profileMenu) fireEvent.click(profileMenu);
    else {
      fireEvent.mouseDown(screen.getByRole('combobox', { name: 'User settings section' }));
      fireEvent.click(await screen.findByText('Account · Profile'));
    }
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Changed name' } });
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    });
    // Save validates multiple retained forms, navigates back, and renders Ant's
    // debounced field errors. Wait for that complete state, not just text insertion
    // within RTL's one-second default while all CI viewports are running.
    await waitFor(
      () => {
        expect(screen.getByText('Choose a preset')).toBeVisible();
        expect(screen.getByRole('heading', { name: 'Claude Code' })).toBeVisible();
        expect(screen.getByRole('button', { name: /^save$/i })).toBeEnabled();
      },
      { timeout: 5_000 }
    );
    // A same-user realtime refresh must not erase the dirty form's errors.
    await act(async () => {
      rendered.rerender(view({ ...user, name: 'Realtime name' }));
    });
    expect(screen.getByText('Choose a preset')).toBeVisible();
    expect(onUpdate).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();

    // Correct the invalid draft and prove Save still flushes both panels once.
    fireEvent.mouseDown(screen.getByLabelText('Preset'));
    fireEvent.click(await screen.findByText('Team preset'));
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /^save$/i }));
    });
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce(), { timeout: 5_000 });
    expect(onUpdate).toHaveBeenCalledOnce();
    expect(onUpdate.mock.calls[0][1]).toMatchObject({
      name: 'Changed name',
      default_agentic_selection: { 'claude-code': { source: 'preset', preset_id: 'preset-a' } },
    });
  });
});
