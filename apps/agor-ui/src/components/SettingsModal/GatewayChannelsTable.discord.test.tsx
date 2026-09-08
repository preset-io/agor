import type { AgorClient, Branch, GatewayChannel, MCPServer, User } from '@agor-live/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp } from 'antd';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { GatewayChannelsTable } from './GatewayChannelsTable';

vi.mock('./BranchSelect', () => ({
  BranchSelect: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <input
      aria-label="branch-select"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('./UserSelect', () => ({
  UserSelect: ({ value, onChange }: { value?: string; onChange?: (value: string) => void }) => (
    <input
      aria-label="user-select"
      value={value ?? ''}
      onChange={(event) => onChange?.(event.target.value)}
    />
  ),
}));
vi.mock('../AgentSelectionGrid', () => ({
  AgentSelectionGrid: ({
    agents,
    onSelect,
  }: {
    agents: { id: string }[];
    onSelect: (agentId: string) => void;
  }) => (
    <div data-testid="agent-grid">
      {agents.map((agent) => (
        <button key={agent.id} type="button" onClick={() => onSelect(agent.id)}>
          {agent.id}
        </button>
      ))}
    </div>
  ),
}));
vi.mock('../AgenticToolConfigForm', async () => {
  const actual = await vi.importActual<typeof import('../AgenticToolConfigForm')>(
    '../AgenticToolConfigForm'
  );
  return {
    ...actual,
    AgenticToolConfigForm: () => <div data-testid="agent-config" />,
  };
});
vi.mock('../AgenticToolConfigurationPicker', async () => {
  const { Form } = await vi.importActual<typeof import('antd')>('antd');
  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: () => (
      <div data-testid="agent-config">
        <Form.Item name="effort" noStyle>
          <select aria-label="gateway-effort" defaultValue="">
            <option value="">Inherited</option>
          </select>
        </Form.Item>
      </div>
    ),
  };
});

const ASYNC = { timeout: 10_000 };
const CHANNEL_ID = '323456789012345678';
const USER_ID = '423456789012345678';
const ROLE_ID = '523456789012345678';
const TOKEN = 'discord-token-for-wizard';

const verifiedConnection = {
  ok: true,
  channelAccess: [
    {
      channelId: CHANNEL_ID,
      ok: true,
      permissions: {
        view: true,
        send: true,
        readHistory: true,
        createPublicThreads: true,
        sendInThreads: false,
      },
    },
  ],
  failures: [],
  notVerifiable: [],
  bot: { userId: '123456789012345678', name: 'Agor' },
  verifiedInstallationId: '123456789012345678',
  verification: { status: 'verified', warnings: [] },
};

function makeClient() {
  const channelCreate = vi.fn().mockResolvedValue({ id: 'channel-discord' });
  const channelPatch = vi.fn().mockResolvedValue({ id: 'channel-discord' });
  const testCreate = vi.fn().mockResolvedValue(verifiedConnection);
  const client = {
    service: (name: string) => {
      if (name === 'gateway-channels') return { create: channelCreate, patch: channelPatch };
      if (name === 'gateway-channels/test') return { create: testCreate };
      return { create: vi.fn(), get: vi.fn() };
    },
  } as unknown as AgorClient;
  return { client, channelCreate, channelPatch, testCreate };
}

function renderTable(client: AgorClient) {
  const branch = {
    branch_id: 'branch-1',
    name: 'main',
    ref: 'main',
  } as unknown as Branch;
  const user = {
    user_id: 'user-1',
    name: 'Ada Lovelace',
    email: 'ada@example.com',
    role: 'admin',
  } as unknown as User;

  return render(
    <MemoryRouter>
      <AntdApp>
        <GatewayChannelsTable
          client={client}
          gatewayChannelById={new Map<string, GatewayChannel>()}
          branchById={new Map([[branch.branch_id, branch]])}
          userById={new Map([[user.user_id, user]])}
          mcpServerById={new Map<string, MCPServer>()}
          currentUser={user}
        />
      </AntdApp>
    </MemoryRouter>
  );
}

function getButton(text: RegExp): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll('button')).find((candidate) =>
    text.test((candidate.textContent || '').trim())
  ) as HTMLButtonElement | undefined;
  if (!button) throw new Error(`No button matching ${text}`);
  return button;
}

function clickButton(text: RegExp) {
  fireEvent.click(getButton(text));
}

async function waitForStep(title: string) {
  await waitFor(() => {
    const currentTitle = document.querySelector(
      '.ant-steps-item-process .ant-steps-item-title'
    )?.textContent;
    expect(currentTitle).toBe(title);
  }, ASYNC);
}

async function waitForAvailableStep(title: string) {
  await waitFor(() => {
    const titles = Array.from(document.querySelectorAll('.ant-steps-item-title')).map(
      (stepTitle) => stepTitle.textContent
    );
    expect(titles).toContain(title);
  }, ASYNC);
}

function selectDiscord() {
  const combobox = document.querySelector('[role="combobox"]');
  if (!combobox) throw new Error('No channel-type Select found');
  fireEvent.mouseDown(combobox);
  fireEvent.click(screen.getByText('Discord'));
}

function addTag(label: string, value: string) {
  const field = screen.getByLabelText(label);
  const input = field.querySelector('input') ?? field;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value } });
  fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
  fireEvent.keyUp(input, { key: 'Enter', code: 'Enter', keyCode: 13, which: 13 });
}

function getTokenInput(): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#discord_bot_token');
  if (!input) throw new Error('No Discord bot token input');
  return input;
}

async function fillDiscordWizard({
  allowedUserId,
  allowedRoleId,
}: {
  allowedUserId?: string;
  allowedRoleId?: string;
}) {
  clickButton(/Add Channel/);
  selectDiscord();
  await waitForAvailableStep('Access');
  fireEvent.change(screen.getByPlaceholderText('e.g., Team Slack, Personal Discord'), {
    target: { value: 'My Discord' },
  });
  fireEvent.change(screen.getByLabelText('branch-select'), { target: { value: 'branch-1' } });
  clickButton(/^Continue$/);
  await waitForStep('Create app');

  expect(screen.getByText('Discord setup')).toBeInTheDocument();
  expect(screen.getByLabelText('Application ID')).toBeInTheDocument();
  expect(screen.getByLabelText('Guild ID')).toBeInTheDocument();
  expect(screen.getByLabelText(/Message Content/)).toBeInTheDocument();
  expect(screen.getByText('Public thread per summon')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Application ID'), {
    target: { value: '123456789012345678' },
  });
  fireEvent.change(screen.getByLabelText('Guild ID'), {
    target: { value: '223456789012345678' },
  });
  fireEvent.click(screen.getByLabelText(/Message Content/));
  clickButton(/^Continue$/);
  await waitForStep('Access');

  expect(screen.getByLabelText('Allowed public text channel IDs')).toBeInTheDocument();
  expect(screen.getByLabelText('Application ID')).not.toBeVisible();
  addTag('Allowed public text channel IDs', CHANNEL_ID);
  if (allowedUserId) addTag('Allowed user IDs', allowedUserId);
  if (allowedRoleId) addTag('Allowed role IDs', allowedRoleId);
  fireEvent.change(screen.getByLabelText('user-select'), { target: { value: 'user-1' } });
  clickButton(/^Continue$/);
  await waitForStep('Token & test');

  expect(screen.getByText('Test Discord connection')).toBeInTheDocument();
  expect(screen.queryByText('Discord (coming soon)')).not.toBeInTheDocument();
  return getTokenInput();
}

async function createDraft(channelCreate: ReturnType<typeof vi.fn>) {
  expect(getTokenInput()).toBeDisabled();
  clickButton(/Create secure draft/);
  await waitFor(() => {
    expect(channelCreate).toHaveBeenCalledTimes(1);
    expect(getTokenInput()).toBeEnabled();
  }, ASYNC);
}

describe('GatewayChannelsTable Discord create wizard', () => {
  it('preserves the bot token through Back/Continue', async () => {
    const { client, channelCreate } = makeClient();
    renderTable(client);
    await fillDiscordWizard({ allowedUserId: USER_ID });
    await createDraft(channelCreate);

    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      enabled: false,
      config: {
        allowed_channel_ids: [CHANNEL_ID],
        allowed_user_ids: [USER_ID],
        allowed_role_ids: [],
      },
    });
    expect(channelCreate.mock.calls[0][0].config.bot_token).toBeUndefined();

    fireEvent.change(getTokenInput(), { target: { value: TOKEN } });
    clickButton(/^Back$/);
    await waitForStep('Access');
    clickButton(/^Continue$/);
    await waitForStep('Token & test');
    expect(getTokenInput()).toHaveValue(TOKEN);
  }, 30_000);

  it('submits the complete draft, verifies stored credentials, then enables', async () => {
    const { client, channelCreate, channelPatch, testCreate } = makeClient();
    renderTable(client);
    await fillDiscordWizard({ allowedUserId: USER_ID, allowedRoleId: ROLE_ID });
    await createDraft(channelCreate);

    expect(channelCreate.mock.calls[0][0]).toMatchObject({
      name: 'My Discord',
      channel_type: 'discord',
      target_branch_id: 'branch-1',
      agor_user_id: 'user-1',
      enabled: false,
      config: {
        application_id: '123456789012345678',
        guild_id: '223456789012345678',
        allowed_channel_ids: [CHANNEL_ID],
        allowed_user_ids: [USER_ID],
        allowed_role_ids: [ROLE_ID],
        message_content_enabled: true,
        thread_mode: 'public_thread_per_summon',
        thread_auto_archive_minutes: 1440,
        align_discord_users: false,
        catch_up: {
          max_pages: 5,
          max_messages: 200,
          max_prompt_bytes: 32768,
          request_timeout_ms: 30000,
          rate_limit_max_retries: 2,
          rate_limit_max_total_delay_ms: 10000,
        },
        files: false,
        agent_tools: [],
      },
    });
    expect(JSON.stringify(channelCreate.mock.calls[0][0])).not.toContain('••••••••');

    fireEvent.change(getTokenInput(), { target: { value: TOKEN } });
    clickButton(/^Back$/);
    await waitForStep('Access');
    clickButton(/^Continue$/);
    await waitForStep('Token & test');
    expect(getTokenInput()).toHaveValue(TOKEN);
    clickButton(/Verify and enable/);
    await waitFor(() => expect(channelPatch).toHaveBeenCalledTimes(2), ASYNC);
    expect(channelPatch.mock.calls[0]).toEqual([
      'channel-discord',
      expect.objectContaining({
        enabled: false,
        config: expect.objectContaining({ bot_token: TOKEN }),
      }),
    ]);
    expect(testCreate).toHaveBeenCalledTimes(1);
    expect(testCreate).toHaveBeenCalledWith({ gatewayChannelId: 'channel-discord' });
    expect(channelPatch.mock.invocationCallOrder[0]).toBeLessThan(
      testCreate.mock.invocationCallOrder[0]
    );
    expect(testCreate.mock.invocationCallOrder[0]).toBeLessThan(
      channelPatch.mock.invocationCallOrder[1]
    );
    expect(channelPatch.mock.calls[1]).toEqual(['channel-discord', { enabled: true }]);
  }, 30_000);
});
