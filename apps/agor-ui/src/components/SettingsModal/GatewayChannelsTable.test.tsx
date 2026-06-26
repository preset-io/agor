import type { AgorClient, Branch, GatewayChannel, MCPServer, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { GatewayChannelsTable } from './GatewayChannelsTable';

function renderWithProviders(ui: React.ReactElement) {
  return render(
    <MemoryRouter>
      <AntdApp>{ui}</AntdApp>
    </MemoryRouter>
  );
}

function makeBranch(): Branch {
  return {
    branch_id: 'branch-1',
    name: 'main',
    ref: 'main',
  } as unknown as Branch;
}

function makeUser(): User {
  return {
    user_id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
  } as unknown as User;
}

function makeSlackChannel(): GatewayChannel {
  return {
    id: 'channel-1',
    name: 'Team Slack',
    channel_type: 'slack',
    channel_key: 'slack:team',
    target_branch_id: 'branch-1',
    agor_user_id: 'user-1',
    enabled: true,
    config: { bot_token: '••••••••', enable_channels: true },
    agentic_config: { agent: 'claude-code' },
    last_message_at: null,
  } as unknown as GatewayChannel;
}

/**
 * Minimal AgorClient stub exposing only the services the table calls. Records
 * the `gateway-channels` create payload and the `gateway-channels/test` probe.
 */
function makeClient(testResult?: unknown) {
  const channelCreate = vi.fn().mockResolvedValue({});
  const testCreate = vi
    .fn()
    .mockResolvedValue(testResult ?? { ok: true, failures: [], notVerifiable: [] });
  const client = {
    service: (name: string) => {
      if (name === 'gateway-channels') return { create: channelCreate };
      if (name === 'gateway-channels/test') return { create: testCreate };
      return { create: vi.fn(), get: vi.fn() };
    },
  } as unknown as AgorClient;
  return { client, channelCreate, testCreate };
}

function renderTable(client: AgorClient | null) {
  const branch = makeBranch();
  const user = makeUser();
  return renderWithProviders(
    <GatewayChannelsTable
      client={client}
      gatewayChannelById={new Map<string, GatewayChannel>()}
      branchById={new Map([[branch.branch_id, branch]])}
      userById={new Map([[user.user_id, user]])}
      mcpServerById={new Map<string, MCPServer>()}
    />
  );
}

/**
 * Open an antd Select by its placeholder, then click the option whose label
 * matches `optionTitle`. The `role="option"` node is an aria helper; the
 * clickable element is `.ant-select-item-option[title=…]`.
 */
async function selectByPlaceholder(placeholder: string, optionTitle: string) {
  fireEvent.mouseDown(screen.getByText(placeholder));
  await screen.findByRole('option', { name: optionTitle });
  const item = document.querySelector(
    `.ant-select-item-option[title="${optionTitle}"]`
  ) as HTMLElement;
  fireEvent.click(item);
}

/** Fill the wizard's Options step and advance to the "Create App" step. */
async function advanceToCreateAppStep() {
  fireEvent.change(screen.getByPlaceholderText('e.g., Team Slack, Personal Discord'), {
    target: { value: 'My Slack' },
  });
  await selectByPlaceholder('Select a branch', 'main');
  await selectByPlaceholder('Select a user', 'Ada Lovelace');
  fireEvent.click(screen.getByRole('button', { name: /Next: Create App/i }));
  await screen.findByRole('button', { name: /Next: Tokens & Test/i });
}

describe('GatewayChannelsTable Slack create wizard', () => {
  it('renders the guided Steps wizard (not the Collapse) on create', () => {
    renderTable(null);
    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    // Wizard step titles + first-step controls.
    expect(screen.getByText('Options')).toBeInTheDocument();
    expect(screen.getByText('Tokens & Test')).toBeInTheDocument();
    expect(screen.getByText('App Name')).toBeInTheDocument();
    expect(screen.getByText('Surfaces')).toBeInTheDocument();
    // DMs are informational (always on), not a toggle.
    expect(screen.getByText('Direct messages')).toBeInTheDocument();
    expect(screen.getByText('always on')).toBeInTheDocument();
    // Slack still owns identity (no generic "Post messages as").
    expect(screen.getByText('Align Slack users')).toBeInTheDocument();
    expect(screen.queryByText('Post messages as')).not.toBeInTheDocument();
  });

  it('updates the manifest preview and scope list as surfaces change', async () => {
    renderTable(null);
    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    // Public-channel scopes/events are absent until the surface is enabled.
    expect(screen.queryByText('channels:history')).not.toBeInTheDocument();
    expect(screen.queryByText('app_mention')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('checkbox', { name: 'Public channels' }));

    // Now they appear in the derived scope/event list (Form.useWatch flush).
    await waitFor(() =>
      expect(screen.queryAllByText('channels:history').length).toBeGreaterThan(0)
    );
    expect(screen.queryAllByText('app_mentions:read').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('app_mention').length).toBeGreaterThan(0);
  });

  it('navigates Options → Create App → Tokens & Test', async () => {
    renderTable(makeClient().client);
    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    await advanceToCreateAppStep();
    expect(screen.getByRole('button', { name: /Copy manifest/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Next: Tokens & Test/i }));
    expect(screen.getByPlaceholderText('xoxb-...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('xapp-...')).toBeInTheDocument();
  }, 30000);

  it('runs the connection probe and renders team/bot/notVerifiable honestly', async () => {
    const result = {
      ok: true,
      team: { id: 'T123', name: 'Acme' },
      bot: { userId: 'U999', name: 'agorbot' },
      appTokenValid: true,
      failures: [],
      notVerifiable: ['Bot must be invited to each channel before it can post'],
    };
    const { client, testCreate } = makeClient(result);
    renderTable(client);
    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    await advanceToCreateAppStep();
    fireEvent.click(screen.getByRole('button', { name: /Next: Tokens & Test/i }));

    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    await waitFor(() => expect(testCreate).toHaveBeenCalledTimes(1));
    expect(testCreate.mock.calls[0][0]).toMatchObject({
      config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
    });

    expect(await screen.findByText('Connection succeeded')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
    expect(screen.getByText('Not verifiable from here')).toBeInTheDocument();
    expect(
      screen.getByText('Bot must be invited to each channel before it can post')
    ).toBeInTheDocument();
  }, 30000);

  it('creates the channel from the final step', async () => {
    const { client, channelCreate } = makeClient();
    renderTable(client);
    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    await advanceToCreateAppStep();
    fireEvent.click(screen.getByRole('button', { name: /Next: Tokens & Test/i }));
    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });

    // OK/Create is only present once the wizard reaches the final step.
    fireEvent.click(screen.getByRole('button', { name: /^Create$/ }));

    await waitFor(() => expect(channelCreate).toHaveBeenCalledTimes(1));
    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      channel_type: 'slack',
      config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
    });
  }, 30000);

  it('invalidates a passing test result when a channel-scope option changes', async () => {
    const { client } = makeClient({ ok: true, failures: [], notVerifiable: [] });
    renderTable(client);
    fireEvent.click(screen.getByRole('button', { name: /Add Channel/i }));

    // Enable a public-channel surface so the scope option is in play.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Public channels' }));

    await advanceToCreateAppStep();
    fireEvent.click(screen.getByRole('button', { name: /Next: Tokens & Test/i }));
    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    expect(await screen.findByText('Connection succeeded')).toBeInTheDocument();

    // Narrowing public channels to a specific set changes the probe config and
    // must clear the now-stale green result.
    fireEvent.click(screen.getByText('Specific channels only'));

    await waitFor(() => expect(screen.queryByText('Connection succeeded')).toBeNull());
  }, 30000);
});

describe('GatewayChannelsTable Slack edit mode', () => {
  it('still renders the Collapse form (not the wizard) when editing', () => {
    const branch = makeBranch();
    const user = makeUser();
    const channel = makeSlackChannel();
    renderWithProviders(
      <GatewayChannelsTable
        client={null}
        gatewayChannelById={new Map([[channel.id, channel]])}
        branchById={new Map([[branch.branch_id, branch]])}
        userById={new Map([[user.user_id, user]])}
        mcpServerById={new Map<string, MCPServer>()}
      />
    );

    fireEvent.click(screen.getByTitle('Edit'));

    // Edit keeps the collapsible sections; the create-only wizard is absent.
    expect(screen.getByText('Credentials')).toBeInTheDocument();
    expect(screen.getByText('Message Sources')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Next: Create App/i })).not.toBeInTheDocument();
  });
});
