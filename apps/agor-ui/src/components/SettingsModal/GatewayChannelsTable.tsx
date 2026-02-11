import type { AgorClient } from '@agor/core/api';
import type {
  AgenticToolName,
  ChannelType,
  GatewayAgenticConfig,
  GatewayChannel,
  MCPServer,
  PermissionMode,
  User,
  UUID,
  Worktree,
} from '@agor/core/types';
import {
  CopyOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  MessageOutlined,
  PlusOutlined,
  SlackOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Divider,
  Form,
  type FormInstance,
  Input,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useEffect, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';

interface GatewayChannelsTableProps {
  client: AgorClient | null;
  gatewayChannelById: Map<string, GatewayChannel>;
  worktreeById: Map<string, Worktree>;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  currentUser?: User | null;
  onCreate?: (data: Partial<GatewayChannel>) => void;
  onUpdate?: (channelId: string, updates: Partial<GatewayChannel>) => void;
  onDelete?: (channelId: string) => void;
}

const CHANNEL_TYPE_OPTIONS: { value: ChannelType; label: string; icon: React.ReactNode }[] = [
  { value: 'slack', label: 'Slack', icon: <SlackOutlined /> },
  { value: 'discord', label: 'Discord', icon: <MessageOutlined /> },
  { value: 'whatsapp', label: 'WhatsApp', icon: <MessageOutlined /> },
  { value: 'telegram', label: 'Telegram', icon: <MessageOutlined /> },
];

function getChannelTypeIcon(type: ChannelType): React.ReactNode {
  switch (type) {
    case 'slack':
      return <SlackOutlined />;
    default:
      return <MessageOutlined />;
  }
}

function getChannelTypeColor(type: ChannelType): string {
  switch (type) {
    case 'slack':
      return 'purple';
    case 'discord':
      return 'blue';
    case 'whatsapp':
      return 'green';
    case 'telegram':
      return 'cyan';
    default:
      return 'default';
  }
}

/** Shared form fields for create and edit modals */
const ChannelFormFields: React.FC<{
  form: FormInstance;
  mode: 'create' | 'edit';
  channelType: ChannelType;
  onChannelTypeChange: (type: ChannelType) => void;
  worktreeById: Map<string, Worktree>;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  selectedAgent: string;
  onAgentChange: (agent: string) => void;
  editingChannel?: GatewayChannel | null;
  onCopyKey?: (key: string) => void;
}> = ({
  form,
  mode,
  channelType,
  onChannelTypeChange,
  worktreeById,
  userById,
  mcpServerById,
  selectedAgent,
  onAgentChange,
  editingChannel,
  onCopyKey,
}) => {
  // Watch message source settings for showing warnings/scope requirements
  const enableChannels = Form.useWatch('enable_channels', form) ?? false;
  const enableGroups = Form.useWatch('enable_groups', form) ?? false;
  const enableMpim = Form.useWatch('enable_mpim', form) ?? false;
  const requireMention = Form.useWatch('require_mention', form) ?? true;
  const alignSlackUsers = Form.useWatch('align_slack_users', form) ?? false;

  return (
    <>
      {mode === 'edit' && editingChannel && (
        <Form.Item label="Channel Key">
          <Input.Search
            value={editingChannel.channel_key}
            readOnly
            enterButton={<CopyOutlined />}
            onSearch={() => onCopyKey?.(editingChannel.channel_key)}
          />
          <Typography.Text
            type="secondary"
            style={{ fontSize: 12, marginTop: 4, display: 'block' }}
          >
            Use this key to authenticate inbound messages from the platform.
          </Typography.Text>
        </Form.Item>
      )}

      <Form.Item
        label="Channel Type"
        name="channel_type"
        initialValue={mode === 'create' ? 'slack' : undefined}
        rules={[{ required: true }]}
      >
        <Select onChange={(value: ChannelType) => onChannelTypeChange(value)}>
          {CHANNEL_TYPE_OPTIONS.map((opt) => (
            <Select.Option key={opt.value} value={opt.value}>
              <Space>
                {opt.icon}
                {opt.label}
              </Space>
            </Select.Option>
          ))}
        </Select>
      </Form.Item>

      <Form.Item
        label="Name"
        name="name"
        rules={[{ required: true, message: 'Please enter a channel name' }]}
      >
        <Input placeholder="e.g., Team Slack, Personal Discord" />
      </Form.Item>

      <Form.Item
        label="Target Worktree"
        name="target_worktree_id"
        rules={[{ required: true, message: 'Please select a target worktree' }]}
        tooltip={
          mode === 'create'
            ? 'New sessions from this channel will be created in this worktree'
            : undefined
        }
      >
        <Select placeholder="Select a worktree" showSearch optionFilterProp="children">
          {Array.from(worktreeById.values()).map((wt) => (
            <Select.Option key={wt.worktree_id} value={wt.worktree_id}>
              {wt.name || wt.ref || wt.worktree_id}
            </Select.Option>
          ))}
        </Select>
      </Form.Item>

      <Form.Item
        label="Post messages as"
        name="agor_user_id"
        rules={[{ required: true, message: 'Please select a user' }]}
        tooltip="Messages from this channel will be attributed to this Agor user. When user alignment is enabled, this acts as the fallback user when a Slack user's email can't be resolved."
      >
        <Select placeholder="Select a user" showSearch optionFilterProp="children">
          {Array.from(userById.values()).map((u) => (
            <Select.Option key={u.user_id} value={u.user_id}>
              {u.name || u.email || u.user_id}
            </Select.Option>
          ))}
        </Select>
      </Form.Item>

      <Form.Item
        label="Enabled"
        name="enabled"
        valuePropName="checked"
        initialValue={mode === 'create' ? true : undefined}
      >
        <Switch />
      </Form.Item>

      <Typography.Text strong style={{ display: 'block', marginBottom: 12, marginTop: 8 }}>
        Platform Configuration
      </Typography.Text>

      {channelType === 'slack' ? (
        <>
          <Form.Item
            label="Bot Token"
            name="bot_token"
            rules={mode === 'create' ? [{ required: true, message: 'Bot token is required' }] : []}
            tooltip="Slack Bot User OAuth Token (xoxb-...)"
          >
            <Input.Password placeholder={mode === 'edit' ? '••••••••' : 'xoxb-...'} />
          </Form.Item>

          <Form.Item
            label="App Token"
            name="app_token"
            rules={mode === 'create' ? [{ required: true, message: 'App token is required' }] : []}
            tooltip="Slack App-Level Token for Socket Mode (xapp-...)"
          >
            <Input.Password placeholder={mode === 'edit' ? '••••••••' : 'xapp-...'} />
          </Form.Item>

          <Alert
            type="info"
            showIcon
            message="Socket Mode Required"
            description="Agor's Slack integration uses Socket Mode for real-time message delivery. Enable Socket Mode in your Slack app settings and generate an app-level token with connections:write scope."
            style={{ marginBottom: 16, fontSize: 12 }}
          />

          <Divider style={{ marginTop: 24, marginBottom: 16 }}>
            <Typography.Text strong>Message Sources</Typography.Text>
          </Divider>

          <Alert
            type="info"
            showIcon
            message="Choose where the bot should listen for messages"
            description="Direct messages are always enabled. Enable additional sources carefully — anyone who can message the bot can interact with your agent. See security documentation."
            style={{ marginBottom: 16 }}
          />

          <Form.Item
            label="Enable Public Channels"
            name="enable_channels"
            valuePropName="checked"
            initialValue={false}
            tooltip="Bot will respond to messages in public channels it's added to"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label="Enable Private Channels"
            name="enable_groups"
            valuePropName="checked"
            initialValue={false}
            tooltip="Bot will respond to messages in private channels it's added to"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label="Enable Group DMs"
            name="enable_mpim"
            valuePropName="checked"
            initialValue={false}
            tooltip="Bot will respond to messages in multi-person direct messages"
          >
            <Switch />
          </Form.Item>

          <Form.Item
            label="Require Bot Mention"
            name="require_mention"
            valuePropName="checked"
            initialValue={true}
            tooltip="When enabled, bot only responds when explicitly @mentioned (recommended for channels)"
          >
            <Switch />
          </Form.Item>

          <Divider style={{ marginTop: 24, marginBottom: 16 }}>
            <Typography.Text strong>User Alignment</Typography.Text>
          </Divider>

          <Form.Item
            label="Align Slack Users with Agor Users"
            name="align_slack_users"
            valuePropName="checked"
            initialValue={false}
            tooltip="When enabled, messages are attributed to the Agor user whose email matches the Slack user's email. Falls back to the 'Post messages as' user if the Slack user has no email. Rejects the message if the email exists but has no Agor account."
          >
            <Switch />
          </Form.Item>

          {alignSlackUsers && (
            <Alert
              type="info"
              showIcon
              message="Additional Slack OAuth Scope Required"
              description={
                <span>
                  User alignment requires the <code>users:read.email</code> scope on your Slack app
                  to look up user email addresses. Without this scope, alignment will silently fall
                  back to the configured &quot;Post messages as&quot; user.
                </span>
              }
              style={{ marginBottom: 16 }}
            />
          )}

          {(enableChannels || enableGroups || enableMpim) && !requireMention && (
            <Alert
              type="warning"
              showIcon
              message="Bot will respond to ALL messages"
              description="With 'Require Bot Mention' disabled, the bot will respond to every message in enabled channels/groups. This can be noisy and expensive. Consider enabling mention requirement."
              style={{ marginBottom: 16 }}
            />
          )}

          {(enableChannels || enableGroups || enableMpim) && (
            <Alert
              type="info"
              showIcon
              message="Required Slack OAuth Scopes"
              description={
                <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, fontSize: 12 }}>
                  <li>
                    <code>chat:write</code> (always required)
                  </li>
                  {enableChannels && (
                    <>
                      <li>
                        <code>channels:history</code> - Read public channel messages
                      </li>
                      <li>
                        <code>app_mentions:read</code> - Receive mention events
                      </li>
                    </>
                  )}
                  {enableGroups && (
                    <li>
                      <code>groups:history</code> - Read private channel messages
                    </li>
                  )}
                  {enableMpim && (
                    <li>
                      <code>mpim:history</code> - Read group DM messages
                    </li>
                  )}
                </ul>
              }
              style={{ marginBottom: 16 }}
            />
          )}

          {(enableChannels || enableGroups || enableMpim) && (
            <Alert
              type="info"
              showIcon
              message="Required Slack Event Subscriptions"
              description={
                <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, fontSize: 12 }}>
                  <li>
                    <code>message.im</code> (always required)
                  </li>
                  {enableChannels && (
                    <>
                      <li>
                        <code>message.channels</code> - Public channel messages
                      </li>
                      <li>
                        <code>app_mention</code> - Bot mention events (recommended)
                      </li>
                    </>
                  )}
                  {enableGroups && (
                    <li>
                      <code>message.groups</code> - Private channel messages
                    </li>
                  )}
                  {enableMpim && (
                    <li>
                      <code>message.mpim</code> - Group DM messages
                    </li>
                  )}
                </ul>
              }
              style={{ marginBottom: 16 }}
            />
          )}

          <Collapse
            ghost
            items={[
              {
                key: 'channel-whitelist',
                label: (
                  <Typography.Text strong style={{ fontSize: 13 }}>
                    Advanced: Channel Whitelist
                  </Typography.Text>
                ),
                children: (
                  <>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
                    >
                      Optionally restrict the bot to specific Slack channels by ID. Leave empty to
                      allow all channels where the bot is added. Find channel IDs in Slack:
                      right-click channel → View channel details → scroll to bottom.
                    </Typography.Text>
                    <Form.Item
                      name="allowed_channel_ids"
                      tooltip="Slack channel IDs (e.g., C01ABC123XY). Press Enter to add each ID."
                    >
                      <Select
                        mode="tags"
                        placeholder="Add channel IDs... (e.g., C01ABC123XY)"
                        style={{ width: '100%' }}
                        tokenSeparators={[',', ' ']}
                      />
                    </Form.Item>
                    <Alert
                      type="info"
                      showIcon
                      message="Whitelist applies to all message sources"
                      description="If set, the bot will ONLY respond in the specified channels, regardless of which message sources are enabled above."
                      style={{ fontSize: 12 }}
                    />
                  </>
                ),
              },
            ]}
            style={{ marginBottom: 16 }}
          />
        </>
      ) : (
        <Alert
          message={`${channelType.charAt(0).toUpperCase() + channelType.slice(1)} support coming soon`}
          description="This platform integration is not yet available. Slack is currently the only supported platform."
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      <Collapse
        ghost
        defaultActiveKey={[]}
        expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
        items={[
          {
            key: 'agentic-tool-config',
            label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
            children: (
              <Space direction="vertical" size="middle" style={{ width: '100%' }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Configure which agent and settings to use for sessions created from this channel.
                </Typography.Text>
                <AgentSelectionGrid
                  agents={AVAILABLE_AGENTS}
                  selectedAgentId={selectedAgent}
                  onSelect={onAgentChange}
                  columns={2}
                  showHelperText={false}
                  showComparisonLink={false}
                />
                <AgenticToolConfigForm
                  agenticTool={selectedAgent as AgenticToolName}
                  mcpServerById={mcpServerById}
                  showHelpText={false}
                />
              </Space>
            ),
          },
        ]}
        style={{ marginTop: 8 }}
      />
    </>
  );
};

export const GatewayChannelsTable: React.FC<GatewayChannelsTableProps> = ({
  client,
  gatewayChannelById,
  worktreeById,
  userById,
  mcpServerById,
  currentUser,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { showSuccess, showError } = useThemedMessage();
  const { token } = theme.useToken();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingChannel, setEditingChannel] = useState<GatewayChannel | null>(null);
  const [channelType, setChannelType] = useState<ChannelType>('slack');
  const [selectedAgent, setSelectedAgent] = useState<string>('claude-code');
  const [createdChannelKey, setCreatedChannelKey] = useState<string | null>(null);
  const [createdChannelType, setCreatedChannelType] = useState<ChannelType | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  // Pre-populate agentic config form with user defaults when agent changes
  useEffect(() => {
    const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent as AgenticToolName];
    if (agentDefaults) {
      const activeForm = editModalOpen ? editForm : createForm;
      activeForm.setFieldsValue({
        permissionMode: agentDefaults.permissionMode,
        modelConfig: agentDefaults.modelConfig,
        mcpServerIds: agentDefaults.mcpServerIds,
        codexSandboxMode: agentDefaults.codexSandboxMode,
        codexApprovalPolicy: agentDefaults.codexApprovalPolicy,
        codexNetworkAccess: agentDefaults.codexNetworkAccess,
      });
    }
  }, [selectedAgent, currentUser, createForm, editForm, editModalOpen]);

  const extractFormData = (
    values: Record<string, unknown>,
    existingConfig?: Record<string, unknown>,
    agent?: string
  ): Partial<GatewayChannel> => {
    const config: Record<string, unknown> = { ...(existingConfig || {}) };
    if (values.channel_type === 'slack') {
      if (values.bot_token) config.bot_token = values.bot_token;
      if (values.app_token) config.app_token = values.app_token;
      if (values.connection_mode) config.connection_mode = values.connection_mode;

      // Message source configuration
      config.enable_channels = values.enable_channels ?? false;
      config.enable_groups = values.enable_groups ?? false;
      config.enable_mpim = values.enable_mpim ?? false;
      config.require_mention = values.require_mention ?? true;
      config.align_slack_users = values.align_slack_users ?? false;

      // Channel whitelist
      // Note: In edit mode, if the form field is mounted and user clears all tags,
      // it will be an empty array. If undefined, it means the field wasn't touched
      // (e.g., in create mode or if form control wasn't rendered), so we preserve
      // the existing config value to avoid accidentally clearing a whitelist.
      if (values.allowed_channel_ids && Array.isArray(values.allowed_channel_ids)) {
        config.allowed_channel_ids = values.allowed_channel_ids;
      } else if (values.allowed_channel_ids === undefined) {
        // Preserve existing value if not provided (field not touched)
        config.allowed_channel_ids = existingConfig?.allowed_channel_ids || [];
      } else {
        // Empty array or other falsy value - clear the whitelist
        config.allowed_channel_ids = [];
      }
    }

    // Build agentic config from form values
    const agenticConfig: GatewayAgenticConfig = {
      agent: (agent || 'claude-code') as AgenticToolName,
      ...(values.permissionMode ? { permissionMode: values.permissionMode as PermissionMode } : {}),
      ...(values.modelConfig
        ? { modelConfig: values.modelConfig as GatewayAgenticConfig['modelConfig'] }
        : {}),
      ...(values.mcpServerIds ? { mcpServerIds: values.mcpServerIds as string[] } : {}),
      ...(values.codexSandboxMode
        ? { codexSandboxMode: values.codexSandboxMode as GatewayAgenticConfig['codexSandboxMode'] }
        : {}),
      ...(values.codexApprovalPolicy
        ? {
            codexApprovalPolicy:
              values.codexApprovalPolicy as GatewayAgenticConfig['codexApprovalPolicy'],
          }
        : {}),
      ...(values.codexNetworkAccess !== undefined
        ? { codexNetworkAccess: values.codexNetworkAccess as boolean }
        : {}),
    };

    return {
      name: values.name as string,
      channel_type: values.channel_type as ChannelType,
      target_worktree_id: values.target_worktree_id as UUID,
      agor_user_id: values.agor_user_id as UUID,
      config,
      agentic_config: agenticConfig,
      enabled: (values.enabled as boolean) ?? true,
    };
  };

  const handleCreate = async () => {
    try {
      const values = await createForm.validateFields();
      const data = extractFormData(values, undefined, selectedAgent);

      if (!client) {
        showError('Not connected to server');
        return;
      }

      const created = (await client.service('gateway-channels').create(data)) as GatewayChannel;
      showSuccess('Gateway channel created!');
      setCreatedChannelType(values.channel_type);
      setCreatedChannelKey(created.channel_key);
      createForm.resetFields();
      setCreateModalOpen(false);
      setChannelType('slack');
    } catch (error: unknown) {
      const err = error as { errorFields?: { errors: string[] }[]; message?: string };
      if (err.errorFields?.length) {
        showError(err.errorFields[0].errors[0] || 'Please fill in required fields');
      } else {
        showError(`Failed to create channel: ${err.message || String(error)}`);
      }
    }
  };

  const handleEdit = (channel: GatewayChannel) => {
    setEditingChannel(channel);
    setChannelType(channel.channel_type);
    const agent = channel.agentic_config?.agent || 'claude-code';
    setSelectedAgent(agent);
    editForm.resetFields();

    const config = channel.config as Record<string, unknown>;

    editForm.setFieldsValue({
      name: channel.name,
      channel_type: channel.channel_type,
      target_worktree_id: channel.target_worktree_id,
      agor_user_id: channel.agor_user_id,
      enabled: channel.enabled,
      connection_mode: config?.connection_mode || 'socket',
      // Message source configuration
      enable_channels: config?.enable_channels ?? false,
      enable_groups: config?.enable_groups ?? false,
      enable_mpim: config?.enable_mpim ?? false,
      require_mention: config?.require_mention ?? true,
      align_slack_users: config?.align_slack_users ?? false,
      allowed_channel_ids: (config?.allowed_channel_ids as string[]) ?? [],
      // Agentic config fields
      permissionMode: channel.agentic_config?.permissionMode,
      modelConfig: channel.agentic_config?.modelConfig,
      mcpServerIds: channel.agentic_config?.mcpServerIds,
      codexSandboxMode: channel.agentic_config?.codexSandboxMode,
      codexApprovalPolicy: channel.agentic_config?.codexApprovalPolicy,
      codexNetworkAccess: channel.agentic_config?.codexNetworkAccess,
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingChannel) return;
    editForm
      .validateFields()
      .then((values) => {
        const updates = extractFormData(
          values,
          editingChannel.config as Record<string, unknown>,
          selectedAgent
        );
        onUpdate?.(editingChannel.id, updates);
        editForm.resetFields();
        setEditModalOpen(false);
        setEditingChannel(null);
        setChannelType('slack');
      })
      .catch((error) => {
        console.error('Form validation failed:', error);
        if (error.errorFields?.length > 0) {
          showError(error.errorFields[0].errors[0] || 'Please fill in required fields');
        }
      });
  };

  const handleToggleEnabled = (channel: GatewayChannel) => {
    onUpdate?.(channel.id, { enabled: !channel.enabled });
  };

  const handleDelete = (channelId: string) => {
    onDelete?.(channelId);
  };

  const handleCopyKey = async (key: string) => {
    try {
      await navigator.clipboard.writeText(key);
      showSuccess('Channel key copied to clipboard');
    } catch {
      showError('Failed to copy to clipboard');
    }
  };

  const columns = [
    {
      title: '',
      key: 'status',
      width: 40,
      render: (_: unknown, channel: GatewayChannel) => (
        <Badge
          status={channel.enabled ? 'success' : 'default'}
          title={channel.enabled ? 'Enabled' : 'Disabled'}
        />
      ),
    },
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
    },
    {
      title: 'Type',
      dataIndex: 'channel_type',
      key: 'channel_type',
      width: 120,
      render: (type: ChannelType) => (
        <Tag icon={getChannelTypeIcon(type)} color={getChannelTypeColor(type)}>
          {type.charAt(0).toUpperCase() + type.slice(1)}
        </Tag>
      ),
    },
    {
      title: 'Target Worktree',
      dataIndex: 'target_worktree_id',
      key: 'target_worktree_id',
      width: 180,
      render: (worktreeId: string) => {
        const wt = worktreeById.get(worktreeId);
        return (
          <Typography.Text type="secondary">
            {wt ? wt.name || wt.ref || worktreeId : worktreeId}
          </Typography.Text>
        );
      },
    },
    {
      title: 'Last Message',
      dataIndex: 'last_message_at',
      key: 'last_message_at',
      width: 160,
      render: (time: string | null) =>
        time ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {new Date(time).toLocaleString()}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Never
          </Typography.Text>
        ),
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      render: (_: unknown, channel: GatewayChannel) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(channel)}
            title="Edit"
          />
          <Switch
            size="small"
            checked={channel.enabled}
            onChange={() => handleToggleEnabled(channel)}
            title={channel.enabled ? 'Disable' : 'Enable'}
          />
          <Popconfirm
            title="Delete gateway channel?"
            description={`Are you sure you want to delete "${channel.name}"? All thread mappings will be lost.`}
            onConfirm={() => handleDelete(channel.id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger title="Delete" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  const channels = mapToArray(gatewayChannelById);

  return (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">
          Route messages from Slack, Discord, and other platforms to Agor sessions.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
          Add Channel
        </Button>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        message="Beta Feature — Security Notice"
        description={
          <>
            The Message Gateway is a <strong>beta feature</strong>. Connecting external messaging
            platforms grants anyone who can message your bot potential access to Agor sessions and
            the underlying worktree environment.{' '}
            <Typography.Link
              href="https://docs.agor.live/guide/message-gateway"
              target="_blank"
              rel="noopener noreferrer"
            >
              Read the full security guidance
            </Typography.Link>{' '}
            before enabling channels in production.
          </>
        }
      />

      {channels.length === 0 ? (
        <div
          style={{
            padding: '60px 20px',
            textAlign: 'center',
            color: token.colorTextTertiary,
          }}
        >
          <MessageOutlined style={{ fontSize: 48, marginBottom: 16, display: 'block' }} />
          <Typography.Text type="secondary" style={{ display: 'block', marginBottom: 8 }}>
            No channels configured.
          </Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Add a channel to route messages from Slack, Discord, or other platforms to Agor
            sessions.
          </Typography.Text>
        </div>
      ) : (
        <Table
          dataSource={channels}
          columns={columns}
          rowKey="id"
          pagination={{ pageSize: 10, showSizeChanger: true }}
          size="small"
        />
      )}

      {/* Create Channel Modal */}
      <Modal
        title="Add Gateway Channel"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          createForm.resetFields();
          setCreateModalOpen(false);
          setChannelType('slack');
          setSelectedAgent('claude-code');
        }}
        okText="Create"
        width={600}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <ChannelFormFields
            form={createForm}
            mode="create"
            channelType={channelType}
            onChannelTypeChange={setChannelType}
            worktreeById={worktreeById}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
          />
        </Form>
      </Modal>

      {/* Edit Channel Modal */}
      <Modal
        title="Edit Gateway Channel"
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          editForm.resetFields();
          setEditModalOpen(false);
          setEditingChannel(null);
          setChannelType('slack');
          setSelectedAgent('claude-code');
        }}
        okText="Save"
        width={600}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 16 }}>
          <ChannelFormFields
            form={editForm}
            mode="edit"
            channelType={channelType}
            onChannelTypeChange={setChannelType}
            worktreeById={worktreeById}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
            editingChannel={editingChannel}
            onCopyKey={handleCopyKey}
          />
        </Form>
      </Modal>

      {/* Post-Create Success Modal */}
      <Modal
        title={null}
        open={createdChannelKey !== null}
        footer={[
          <Button
            key="done"
            type="primary"
            onClick={() => {
              setCreatedChannelKey(null);
              setCreatedChannelType(null);
            }}
          >
            Done
          </Button>,
        ]}
        onCancel={() => {
          setCreatedChannelKey(null);
          setCreatedChannelType(null);
        }}
        width={560}
      >
        <Result
          status="success"
          title="Channel Created"
          subTitle="Your gateway channel has been created. Use the channel key below to configure your platform integration."
        />
        {createdChannelKey && createdChannelKey !== 'pending' && (
          <div style={{ padding: '0 24px 16px' }}>
            <Alert
              message="Channel Key"
              description={
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Input.Search
                    value={createdChannelKey}
                    readOnly
                    enterButton={<CopyOutlined />}
                    onSearch={() => handleCopyKey(createdChannelKey)}
                    style={{ fontFamily: 'monospace' }}
                  />
                  <Typography.Text type="warning" style={{ fontSize: 12 }}>
                    Keep this key secret — it authenticates messages from the platform to Agor.
                  </Typography.Text>
                </Space>
              }
              type="warning"
              showIcon
              style={{ marginBottom: 16 }}
            />
            {createdChannelType === 'slack' && (
              <Alert
                message="Slack Setup"
                description={
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                    <li>Install the Slack app to your workspace</li>
                    <li>Enable Socket Mode in your Slack app settings</li>
                    <li>
                      Add required OAuth scopes: <code>chat:write</code> (and others based on
                      enabled message sources)
                    </li>
                    <li>
                      Subscribe to bot events: <code>message.im</code> (and others based on enabled
                      message sources)
                    </li>
                    <li>The gateway will automatically connect when the channel is enabled</li>
                  </ol>
                }
                type="info"
                showIcon
              />
            )}
          </div>
        )}
        {createdChannelKey === 'pending' && (
          <div style={{ padding: '0 24px 16px' }}>
            <Alert
              message="Channel key will appear here after the server processes the request."
              type="info"
              showIcon
            />
          </div>
        )}
      </Modal>
    </div>
  );
};
