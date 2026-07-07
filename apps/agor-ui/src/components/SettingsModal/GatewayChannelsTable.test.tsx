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

/** Fill the universal "Channel" step (step 0) and advance to "Options" (step 1). */
async function advanceToOptions() {
  fireEvent.change(screen.getByPlaceholderText('e.g., Team Slack, Personal Discord'), {
    target: { value: 'My Slack' },
  });
  fireEvent.change(screen.getByLabelText('branch-select'), { target: { value: 'branch-1' } });
  clickButton(/^Continue$/);
  await flush();
}

/**
 * Advance from "Options" to the "Create app" step (step 2). Slack defaults to
 * aligning Slack users, so no run-as user is required and no user-select renders.
 */
async function advanceToCreateAppStep() {
  await advanceToOptions();
  clickButton(/^Continue$/);
  await flush();
}

/** Advance all the way to the final "Tokens & test" step (step 3). */
async function advanceToTokensStep() {
  await advanceToCreateAppStep();
  clickButton(/^Continue$/);
  await flush();
}

describe('GatewayChannelsTable Slack create wizard', () => {
  it('opens on the universal "Channel" step with the unified step indicator', () => {
    renderTable(null);
    clickButton(/Add Channel/);

    // Step indicator titles for the Slack flow sit under the modal title.
    expect(screen.getByText('Channel')).toBeInTheDocument();
    expect(screen.getByText('Options')).toBeInTheDocument();
    expect(screen.getByText('Create app')).toBeInTheDocument();
    expect(screen.getByText('Tokens & test')).toBeInTheDocument();

    // Step 0 owns the universal basics; platform options live on later steps.
    expect(screen.getByText('Channel Type')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
    expect(screen.getByText('Target Branch')).toBeInTheDocument();
    expect(screen.getByText('Enabled')).toBeInTheDocument();
    // Slack-specific options (App Name / Surfaces) are not shown yet.
    expect(screen.queryByText('Surfaces')).not.toBeInTheDocument();
    // Slack owns identity later — no generic "Post messages as".
    expect(screen.queryByText('Post messages as')).not.toBeInTheDocument();
  });

  it('keeps one footer on every step: Back disabled on step 0, primary verb on the last step', async () => {
    renderTable(makeClient().client);
    clickButton(/Add Channel/);

    // Step 0: Back present-but-disabled; primary is "Continue"; no submit verb yet.
    expect(getButton(/^Back$/).disabled).toBe(true);
    expect(getButton(/^Cancel$/)).toBeInTheDocument();
    expect(getButton(/^Continue$/)).toBeInTheDocument();
    expect(queryButton(/Create channel/)).toBeUndefined();

    // Mid-flow: Back enabled, still on "Continue".
    await advanceToOptions();
    expect(getButton(/^Back$/).disabled).toBe(false);
    expect(getButton(/^Continue$/)).toBeInTheDocument();

    // Surfaces appear on the Options step.
    expect(screen.getByText('Surfaces')).toBeInTheDocument();
    expect(screen.getByText('Align Slack users')).toBeInTheDocument();

    // Slack aligns users by default, so no run-as user is required to advance.
    clickButton(/^Continue$/);
    await flush();
    expect(getButton(/Copy manifest/)).toBeInTheDocument();
    clickButton(/^Continue$/);
    await flush();
    expect(getButton(/Create channel/)).toBeInTheDocument();
    expect(queryButton(/^Continue$/)).toBeUndefined();
    expect(screen.getByPlaceholderText('xoxb-...')).toBeInTheDocument();
    expect(screen.getByPlaceholderText('xapp-...')).toBeInTheDocument();
  });

  it('updates the manifest preview and scope list as surfaces change', async () => {
    renderTable(null);
    clickButton(/Add Channel/);
    // Surfaces live on the Options step (step 1).
    await advanceToOptions();

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

    await advanceToTokensStep();

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

    await advanceToTokensStep();
    fireEvent.change(screen.getByPlaceholderText('xoxb-...'), { target: { value: 'xoxb-test' } });
    fireEvent.change(screen.getByPlaceholderText('xapp-...'), { target: { value: 'xapp-test' } });

    // The submit verb appears only on the final step; it drives the create call.
    clickButton(/Create channel/);

    await waitFor(() => expect(channelCreate).toHaveBeenCalledTimes(1));
    // Slack defaults to aligning users, so the channel is valid with no run-as
    // user: align_slack_users is true and no agor_user_id was collected.
    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      channel_type: 'slack',
      config: {
        bot_token: 'xoxb-test',
        app_token: 'xapp-test',
        align_slack_users: true,
        // The wizard only creates inbound/Socket-Mode Slack channels, so it
        // records connection_mode:'socket' — this is what makes
        // getRequiredSecretFields require app_token for UI-created channels.
        connection_mode: 'socket',
      },
    });
    expect(channelCreate.mock.calls[0][0].agor_user_id).toBeFalsy();
  });

  it('invalidates a passing test result when a channel-scope option changes', async () => {
    const { client } = makeClient({ ok: true, failures: [], notVerifiable: [] });
    renderTable(client);
    clickButton(/Add Channel/);

    // Enable a public-channel surface (Options step) so the scope option is in play.
    await advanceToOptions();
    fireEvent.click(screen.getByText('Public channels'));

    // Slack aligns users by default — no run-as user needed. Walk to Tokens step.
    clickButton(/^Continue$/);
    await flush();
    clickButton(/^Continue$/);
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

/**
 * Render the table with a single Slack channel and open its edit modal. The
 * edit Collapse keeps inactive panels mounted (`destroyOnHidden={false}`), but
 * children render lazily — call {@link expandPanel} to reveal a section's body.
 */
function renderEditTable(client: AgorClient | null, channel: GatewayChannel) {
  const branch = makeBranch();
  const user = makeUser();
  renderWithProviders(
    <GatewayChannelsTable
      client={client}
      gatewayChannelById={new Map([[channel.id, channel]])}
      branchById={new Map([[branch.branch_id, branch]])}
      userById={new Map([[user.user_id, user]])}
      mcpServerById={new Map<string, MCPServer>()}
    />
  );
  fireEvent.click(screen.getByTitle('Edit'));
}

/** Expand a Collapse section by clicking its header label. */
function expandPanel(title: string) {
  fireEvent.click(screen.getByText(title));
}

describe('GatewayChannelsTable Slack edit mode', () => {
  it('still renders the Collapse form (not the wizard) when editing', () => {
    renderEditTable(null, makeSlackChannel());

    // Edit keeps the collapsible sections; the create-only wizard is absent.
    expect(screen.getByText('Credentials')).toBeInTheDocument();
    expect(screen.getByText('Message Sources')).toBeInTheDocument();
    // No unified step indicator and no wizard footer in edit mode.
    expect(screen.queryByText('Tokens & test')).not.toBeInTheDocument();
    expect(queryButton(/^Continue$/)).toBeUndefined();
  });

  it('copies the recommended manifest derived from the channel options', async () => {
    // Intercept the clipboard write robustly. Some jsdom builds ship a real
    // `navigator.clipboard` whose method a `defineProperty({ value })` swap does
    // not replace — the component then calls the real `writeText` and a fresh
    // mock records 0 calls. Spy on whatever clipboard object exists (creating a
    // minimal one only when the environment provides none) so OUR spy is always
    // the function invoked. A secure context keeps the modern Clipboard path on.
    Object.defineProperty(globalThis, 'isSecureContext', { value: true, configurable: true });
    if (!navigator.clipboard?.writeText) {
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: () => Promise.resolve() },
        configurable: true,
      });
    }
    const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);

    // enable_channels: true ⇒ public-channel scopes + the app_mention event.
    renderEditTable(null, makeSlackChannel());
    expandPanel('App Manifest');

    // The manifest derives from Form.useWatch, which propagates the edited
    // values on the next tick — wait for the public-channel scope to appear.
    await waitFor(() =>
      expect(document.querySelector('pre')?.textContent ?? '').toContain('"channels:history"')
    );
    const manifest = document.querySelector('pre')?.textContent ?? '';
    expect(manifest).toContain('"app_mention"');
    // Channel surfaces trigger on app_mention, never message.* channel events.
    expect(manifest).not.toContain('message.channels');

    clickButton(/Copy app manifest/);
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
    expect(writeText.mock.calls[0][0]).toContain('"channels:history"');
  });

  it('tests an existing channel via gatewayChannelId (never form tokens)', async () => {
    const result = {
      ok: true,
      team: { id: 'T123', name: 'Acme' },
      appTokenValid: true,
      failures: [],
      notVerifiable: [],
    };
    const { client, testCreate } = makeClient(result);
    renderEditTable(client, makeSlackChannel());
    expandPanel('Credentials');

    clickButton(/Test connection/);

    await waitFor(() => expect(testCreate).toHaveBeenCalledTimes(1));
    expect(testCreate.mock.calls[0][0]).toEqual({ gatewayChannelId: 'channel-1' });
    expect(await screen.findByText('Connection succeeded')).toBeInTheDocument();
    expect(screen.getByText('Acme')).toBeInTheDocument();
  });

  it('derives the Message Sources scope/event list (no stale message.* events)', async () => {
    renderEditTable(null, makeSlackChannel());
    expandPanel('Message Sources');

    // Derived from requiredBotScopes/requiredBotEvents for public channels; the
    // watched enable_channels value propagates on the next tick.
    await waitFor(() =>
      expect(screen.queryAllByText('channels:history').length).toBeGreaterThan(0)
    );
    expect(screen.queryAllByText('app_mentions:read').length).toBeGreaterThan(0);
    expect(screen.queryAllByText('app_mention').length).toBeGreaterThan(0);
    // Channel surfaces subscribe to app_mention, never message.* channel events.
    expect(screen.queryByText('message.channels')).toBeNull();
  });

  it('shows stored vs not-set status for the token fields', () => {
    // bot_token is stored (non-empty fixture value); app_token is absent.
    renderEditTable(null, makeSlackChannel());
    expandPanel('Credentials');

    expect(screen.getByText('Stored')).toBeInTheDocument();
    expect(screen.getByText('Not set')).toBeInTheDocument();
    expect(
      screen.getByText('A token is stored. Leave blank to keep it; enter a value to overwrite it.')
    ).toBeInTheDocument();
    expect(
      screen.getByText('No token stored yet. Enter the app token (xapp-...).')
    ).toBeInTheDocument();
  });
});

describe('GatewayChannelsTable GitHub create wizard', () => {
  it('walks Channel → Create app → Credentials → Configure and builds a github payload', async () => {
    const { client, channelCreate } = makeClient();
    renderTable(client);
    clickButton(/Add Channel/);

    // Switch the channel type to GitHub via the (real) antd Select.
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('GitHub'));

    // Step 0 (Channel): GitHub picks identity later, so only name + branch here.
    fireEvent.change(screen.getByPlaceholderText('e.g., Team Slack, Personal Discord'), {
      target: { value: 'My GH' },
    });
    fireEvent.change(screen.getByLabelText('branch-select'), { target: { value: 'branch-1' } });
    clickButton(/^Continue$/);
    await flush();

    // Step 1 (Create app): no required fields — Continue straight through.
    expect(screen.getByText(/Create GitHub App on GitHub/)).toBeInTheDocument();
    clickButton(/^Continue$/);
    await flush();

    // Step 2 (Credentials): App ID + private key, then Continue.
    fireEvent.change(screen.getByPlaceholderText('123456'), { target: { value: '111' } });
    fireEvent.change(screen.getByPlaceholderText(/BEGIN RSA PRIVATE KEY/), {
      target: { value: 'pem-body' },
    });
    clickButton(/^Continue$/);
    await flush();

    // Step 3 (Configure): watch repos (tags Select, tokenized via comma) + identity.
    const watchRepos = document.querySelector('#github_watch_repos') as HTMLInputElement;
    fireEvent.change(watchRepos, { target: { value: 'preset-io/agor,' } });
    fireEvent.change(screen.getByLabelText('user-select'), { target: { value: 'user-1' } });

    clickButton(/Create channel/);
    await flush();

    await waitFor(() => expect(channelCreate).toHaveBeenCalledTimes(1));
    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      channel_type: 'github',
      name: 'My GH',
      target_branch_id: 'branch-1',
      config: { app_id: 111, watch_repos: ['preset-io/agor'] },
    });
  });
});

describe('GatewayChannelsTable Teams create wizard', () => {
  it('walks Channel → Setup and builds a teams payload', async () => {
    const { client, channelCreate } = makeClient();
    renderTable(client);
    clickButton(/Add Channel/);

    // Switch the channel type to Microsoft Teams via the (real) antd Select.
    fireEvent.mouseDown(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Microsoft Teams'));

    // Step 0 for Teams includes the generic "Post messages as" identity.
    fireEvent.change(screen.getByPlaceholderText('e.g., Team Slack, Personal Discord'), {
      target: { value: 'My Teams' },
    });
    fireEvent.change(screen.getByLabelText('branch-select'), { target: { value: 'branch-1' } });
    fireEvent.change(screen.getByLabelText('user-select'), { target: { value: 'user-1' } });
    clickButton(/^Continue$/);
    await flush();

    // Setup step (final): Azure Bot credentials.
    fireEvent.change(document.querySelector('#teams_app_id') as HTMLInputElement, {
      target: { value: 'app-123' },
    });
    fireEvent.change(screen.getByPlaceholderText('Client secret value'), {
      target: { value: 'secret' },
    });
    fireEvent.change(document.querySelector('#teams_tenant_id') as HTMLInputElement, {
      target: { value: 'tenant-123' },
    });

    clickButton(/Create channel/);
    await flush();

    await waitFor(() => expect(channelCreate).toHaveBeenCalledTimes(1));
    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      channel_type: 'teams',
      name: 'My Teams',
      target_branch_id: 'branch-1',
      agor_user_id: 'user-1',
      config: { app_id: 'app-123', tenant_id: 'tenant-123' },
    });
  });
});
