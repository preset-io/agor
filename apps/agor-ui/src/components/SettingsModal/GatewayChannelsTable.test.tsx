import type { AgorClient, Branch, GatewayChannel, MCPServer, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { GatewayChannelsTable } from './GatewayChannelsTable';

// The real branch/user pickers are antd v6 `Select`s; opening their dropdowns in
// jsdom is pathologically slow. Replace them with trivial native inputs so the
// wizard's required identity fields can be filled instantly and deterministically.
vi.mock('./BranchSelect', () => ({
  BranchSelect: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <input
      aria-label="branch-select"
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));
vi.mock('./UserSelect', () => ({
  UserSelect: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <input
      aria-label="user-select"
      value={value ?? ''}
      onChange={(e) => onChange?.(e.target.value)}
    />
  ),
}));

// The agent-configuration widgets mount inside the wizard's final step and the
// edit collapse; they're heavy (agent cards + model/MCP selects) and irrelevant
// to the gateway-wizard assertions. Stub them so step transitions stay fast.
vi.mock('../AgentSelectionGrid', () => ({
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../AgenticToolConfigForm', () => ({
  AgenticToolConfigForm: () => <div data-testid="agent-config" />,
}));

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

// `getByRole('button', { name })` computes accessible names across the whole
// (large) antd modal DOM and costs seconds per call in jsdom — enough to time
// out the wizard tests in CI. Match buttons by trimmed text via querySelector
// instead, which is effectively instant.
function queryButton(text: RegExp): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find((b) =>
    text.test((b.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
}
function getButton(text: RegExp): HTMLButtonElement {
  const button = queryButton(text);
  if (!button) throw new Error(`No button matching ${text}`);
  return button;
}
function clickButton(text: RegExp) {
  fireEvent.click(getButton(text));
}
/** Drain microtasks so a Form.validateFields()-gated step transition settles. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Fill the wizard's Options step and advance to the "Create App" step. */
async function advanceToCreateAppStep() {
  fireEvent.change(screen.getByPlaceholderText('e.g., Team Slack, Personal Discord'), {
    target: { value: 'My Slack' },
  });
  fireEvent.change(screen.getByLabelText('branch-select'), { target: { value: 'branch-1' } });
  fireEvent.change(screen.getByLabelText('user-select'), { target: { value: 'user-1' } });
  clickButton(/Next: Create App/);
  await flush();
}

describe('GatewayChannelsTable Slack create wizard', () => {
  it('renders the guided Steps wizard (not the Collapse) on create', () => {
    renderTable(null);
    clickButton(/Add Channel/);

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
    clickButton(/Add Channel/);

    // Public-channel scopes/events are absent until the surface is enabled.
    expect(screen.queryByText('channels:history')).not.toBeInTheDocument();
    expect(screen.queryByText('app_mention')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('Public channels'));

    // Now they appear in the derived scope/event list (Form.useWatch flush).
    await waitFor(() =>
      expect(screen.queryAllByText('channels:history').length).toBeGreaterThan(0)
    );
    expect(screen.queryAllByText('app_mentions:read').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('app_mention').length).toBeGreaterThan(0);
  });

  it('navigates Options → Create App → Tokens & Test, gating the OK button', async () => {
    renderTable(makeClient().client);
    clickButton(/Add Channel/);

    // OK/Create stays hidden until the wizard reaches its final step.
    expect(getButton(/^Create$/).style.display).toBe('none');

    await advanceToCreateAppStep();
    expect(getButton(/Copy manifest/)).toBeInTheDocument();
    expect(getButton(/^Create$/).style.display).toBe('none');

    clickButton(/Next: Tokens & Test/);
    await flush();

    expect(getButton(/^Create$/).style.display).toBe('');
    expect(screen.getByPlaceholderText('xoxb-...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('xapp-...')).toBeInTheDocument();
  });

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
    clickButton(/Add Channel/);

    await advanceToCreateAppStep();
    clickButton(/Next: Tokens & Test/);
    await flush();

    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });
    clickButton(/Test connection/);

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
  });

  it('creates the channel from the final step', async () => {
    const { client, channelCreate } = makeClient();
    renderTable(client);
    clickButton(/Add Channel/);

    await advanceToCreateAppStep();
    clickButton(/Next: Tokens & Test/);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });

    // OK/Create is only shown once the wizard reaches the final step.
    clickButton(/^Create$/);

    await waitFor(() => expect(channelCreate).toHaveBeenCalledTimes(1));
    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      channel_type: 'slack',
      config: { bot_token: 'xoxb-test', app_token: 'xapp-test' },
    });
  });

  it('invalidates a passing test result when a channel-scope option changes', async () => {
    const { client } = makeClient({ ok: true, failures: [], notVerifiable: [] });
    renderTable(client);
    clickButton(/Add Channel/);

    // Enable a public-channel surface so the scope option is in play.
    fireEvent.click(screen.getByText('Public channels'));

    await advanceToCreateAppStep();
    clickButton(/Next: Tokens & Test/);
    await flush();
    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });
    clickButton(/Test connection/);

    expect(await screen.findByText('Connection succeeded')).toBeInTheDocument();

    // Narrowing public channels to a specific set changes the probe config and
    // must clear the now-stale green result.
    fireEvent.click(screen.getByText('Specific channels only'));

    await waitFor(() => expect(screen.queryByText('Connection succeeded')).toBeNull());
  });
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
    expect(queryButton(/Next: Create App/)).toBeUndefined();
  });
});
