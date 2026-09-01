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
  AgentSelectionGrid: () => <div data-testid="agent-grid" />,
}));
vi.mock('../AgenticToolConfigForm', async () => {
  const actual = await vi.importActual<typeof import('../AgenticToolConfigForm')>(
    '../AgenticToolConfigForm'
  );
  return { ...actual, AgenticToolConfigForm: () => <div data-testid="agent-config" /> };
});
vi.mock('../AgenticToolConfigurationPicker', async () => {
  const { Form } = await vi.importActual<typeof import('antd')>('antd');
  return {
    INLINE_AGENTIC_CONFIGURATION: '__inline__',
    AgenticToolConfigurationPicker: () => (
      <Form.Item name="effort" noStyle>
        <select aria-label="gateway-effort" defaultValue="">
          <option value="">Inherited</option>
        </select>
      </Form.Item>
    ),
  };
});

const CHANNEL_ID = '323456789012345678';
const USER_ID = '423456789012345678';

function makeDiscordChannel(): GatewayChannel {
  return {
    id: 'channel-discord',
    name: 'My Discord',
    channel_type: 'discord',
    channel_key: 'discord:223456789012345678',
    target_branch_id: 'branch-1',
    agor_user_id: 'user-1',
    enabled: false,
    config: {
      application_id: '123456789012345678',
      guild_id: '223456789012345678',
      allowed_channel_ids: [CHANNEL_ID],
      allowed_user_ids: [USER_ID],
      allowed_role_ids: [],
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
    },
    agentic_config: { agent: 'claude-code' },
    last_message_at: null,
  } as unknown as GatewayChannel;
}

describe('GatewayChannelsTable Discord manual connection test', () => {
  it('invokes the probe and renders channel permissions', async () => {
    const channelPatch = vi.fn().mockResolvedValue({ id: 'channel-discord' });
    const testCreate = vi.fn().mockResolvedValue({
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
    });
    const client = {
      service: (name: string) => {
        if (name === 'gateway-channels') return { patch: channelPatch };
        if (name === 'gateway-channels/test') return { create: testCreate };
        return { create: vi.fn(), get: vi.fn() };
      },
    } as unknown as AgorClient;
    const branch = { branch_id: 'branch-1', name: 'main', ref: 'main' } as unknown as Branch;
    const user = {
      user_id: 'user-1',
      name: 'Ada Lovelace',
      email: 'ada@example.com',
    } as unknown as User;
    const channel = makeDiscordChannel();

    render(
      <MemoryRouter>
        <AntdApp>
          <GatewayChannelsTable
            client={client}
            gatewayChannelById={new Map([[channel.id, channel]])}
            branchById={new Map([[branch.branch_id, branch]])}
            userById={new Map([[user.user_id, user]])}
            mcpServerById={new Map<string, MCPServer>()}
            currentUser={user}
          />
        </AntdApp>
      </MemoryRouter>
    );

    fireEvent.click(screen.getByTitle('Edit'));
    fireEvent.click(screen.getByText('Test Discord connection'));

    await waitFor(() => {
      expect(
        screen.getByText(/view ok, send ok, history ok, public threads ok, thread replies no/)
      ).toBeInTheDocument();
    });
    expect(channelPatch).not.toHaveBeenCalled();
    expect(testCreate).toHaveBeenCalledTimes(1);
    expect(testCreate).toHaveBeenCalledWith({
      gatewayChannelId: 'channel-discord',
      config: expect.objectContaining({
        application_id: '123456789012345678',
        allowed_channel_ids: [CHANNEL_ID],
      }),
    });
  });
});
