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
  EditOutlined,
  GithubOutlined,
  KeyOutlined,
  LoadingOutlined,
  MessageOutlined,
  PlusOutlined,
  SlackOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Collapse,
  Descriptions,
  Form,
  type FormInstance,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Result,
  Select,
  Space,
  Spin,
  Steps,
  Switch,
  Table,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDaemonUrl } from '@/config/daemon';
import { copyToClipboard } from '@/utils/clipboard';
import { mapToSortedArray } from '@/utils/mapHelpers';
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
  { value: 'github', label: 'GitHub', icon: <GithubOutlined /> },
  { value: 'discord', label: 'Discord', icon: <MessageOutlined /> },
  { value: 'whatsapp', label: 'WhatsApp', icon: <MessageOutlined /> },
  { value: 'telegram', label: 'Telegram', icon: <MessageOutlined /> },
];

function getChannelTypeIcon(type: ChannelType): React.ReactNode {
  switch (type) {
    case 'slack':
      return <SlackOutlined />;
    case 'github':
      return <GithubOutlined />;
    default:
      return <MessageOutlined />;
  }
}

function getChannelTypeColor(type: ChannelType): string {
  switch (type) {
    case 'slack':
      return 'purple';
    case 'github':
      return 'default';
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

/** Collapsible section header with icon */
const SectionLabel: React.FC<{ icon: React.ReactNode; title: string; subtitle?: string }> = ({
  icon,
  title,
  subtitle,
}) => (
  <Space size="small">
    {icon}
    <span>
      <Typography.Text strong>{title}</Typography.Text>
      {subtitle && (
        <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
          {subtitle}
        </Typography.Text>
      )}
    </span>
  </Space>
);

// ============================================================================
// GitHub App Setup Types & Helpers
// ============================================================================

/** Credentials fetched from the daemon after GitHub App manifest creation */
interface GitHubSetupCredentials {
  app_id: number;
  slug: string;
  pem: string;
  webhook_secret: string;
  owner: string;
  owner_type: string;
  html_url: string;
}

/** Simplified GitHub App installation */
interface GitHubInstallation {
  id: number;
  account: {
    login?: string;
    type: string;
    avatar_url: string;
  } | null;
  repository_selection: string;
  html_url: string;
  app_slug: string;
  target_type: string;
}

/** Parameters passed via URL from the GitHub App manifest callback */
interface GitHubSetupParams {
  setup_token: string;
  app_id: string;
  slug: string;
  owner: string;
  html_url: string;
}

/** GitHub setup wizard steps */
const GITHUB_SETUP_STEPS = [
  { title: 'Create App' },
  { title: 'Select Installation' },
  { title: 'Configure' },
];

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
  /** GitHub setup wizard state (managed by parent) */
  githubStep: number;
  onGithubStepChange: (step: number) => void;
  githubCredentials: GitHubSetupCredentials | null;
  githubInstallations: GitHubInstallation[];
  githubLoading: boolean;
  githubError: string | null;
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
  githubStep,
  onGithubStepChange,
  githubCredentials,
  githubInstallations,
  githubLoading,
  githubError,
}) => {
  // Watch message source settings for showing warnings/scope requirements
  const enableChannels = Form.useWatch('enable_channels', form) ?? false;
  const enableGroups = Form.useWatch('enable_groups', form) ?? false;
  const enableMpim = Form.useWatch('enable_mpim', form) ?? false;
  const requireMention = Form.useWatch('require_mention', form) ?? true;
  const alignSlackUsers = Form.useWatch('align_slack_users', form) ?? false;

  const sourcesEnabled = enableChannels || enableGroups || enableMpim;

  return (
    <>
      {/* ── Basic Settings (always visible) ── */}
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
        tooltip="Messages from this channel will be attributed to this Agor user. When user alignment is enabled, this acts as the fallback user."
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

      {channelType !== 'slack' && channelType !== 'github' && (
        <Alert
          message={`${channelType.charAt(0).toUpperCase() + channelType.slice(1)} support coming soon`}
          description="This platform integration is not yet available. Slack and GitHub are currently supported."
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* ── GitHub App Setup Wizard ── */}
      {channelType === 'github' && (
        <>
          <Steps
            current={githubStep}
            size="small"
            items={GITHUB_SETUP_STEPS}
            style={{ marginBottom: 24 }}
          />

          {githubLoading && (
            <div style={{ textAlign: 'center', padding: '24px 0' }}>
              <Spin indicator={<LoadingOutlined spin />} />
              <Typography.Text type="secondary" style={{ display: 'block', marginTop: 8 }}>
                Loading GitHub App data...
              </Typography.Text>
            </div>
          )}

          {githubError && (
            <Alert
              type="error"
              showIcon
              message="GitHub Setup Error"
              description={githubError}
              style={{ marginBottom: 16 }}
            />
          )}

          {/* Step 0: Create GitHub App */}
          {githubStep === 0 && !githubLoading && mode === 'create' && (
            <div style={{ marginBottom: 16 }}>
              <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
                Create a GitHub App to connect Agor to your repositories. This uses GitHub&apos;s
                App Manifest flow — you&apos;ll be redirected to GitHub to authorize the app, then
                brought back here to complete setup.
              </Typography.Paragraph>

              <Form.Item label="App Name" name="github_app_name">
                <Input placeholder="Agor (optional — defaults to 'Agor')" />
              </Form.Item>

              <Form.Item
                label="Target Organization"
                name="github_org"
                tooltip="Leave empty to create the app under your personal GitHub account"
              >
                <Input placeholder="my-org (optional)" />
              </Form.Item>

              <Button
                type="primary"
                icon={<GithubOutlined />}
                block
                onClick={() => {
                  const daemonUrl = getDaemonUrl();
                  const params = new URLSearchParams();
                  const appName = form.getFieldValue('github_app_name');
                  const org = form.getFieldValue('github_org');
                  if (appName) params.set('name', appName);
                  if (org) params.set('org', org);
                  const qs = params.toString();
                  window.open(`${daemonUrl}/api/github/manifest${qs ? `?${qs}` : ''}`, '_blank');
                }}
              >
                Create GitHub App on GitHub
              </Button>

              <Alert
                type="info"
                showIcon
                message="What happens next?"
                description={
                  <ol style={{ margin: '4px 0 0 0', paddingLeft: 20, fontSize: 12 }}>
                    <li>You&apos;ll be redirected to GitHub to review and create the app</li>
                    <li>GitHub redirects back here with the app credentials</li>
                    <li>Pick which installation (org/repos) to connect</li>
                    <li>Configure polling and mention settings</li>
                  </ol>
                }
                style={{ marginTop: 16, fontSize: 12 }}
              />
            </div>
          )}

          {/* Step 1: Installation Picker */}
          {githubStep === 1 && !githubLoading && githubCredentials && (
            <div style={{ marginBottom: 16 }}>
              <Descriptions
                size="small"
                column={1}
                style={{ marginBottom: 16 }}
                items={[
                  { label: 'GitHub App', children: githubCredentials.slug },
                  {
                    label: 'Owner',
                    children: `${githubCredentials.owner} (${githubCredentials.owner_type})`,
                  },
                  {
                    label: 'App URL',
                    children: (
                      <Typography.Link
                        href={githubCredentials.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {githubCredentials.html_url}
                      </Typography.Link>
                    ),
                  },
                ]}
              />

              {githubInstallations.length === 0 ? (
                <Alert
                  type="warning"
                  showIcon
                  message="No installations found"
                  description={
                    <span>
                      The GitHub App hasn&apos;t been installed on any organization or account yet.{' '}
                      <Typography.Link
                        href={githubCredentials.html_url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        Install it on GitHub
                      </Typography.Link>{' '}
                      first, then refresh this page.
                    </span>
                  }
                  style={{ marginBottom: 16 }}
                />
              ) : (
                <Form.Item
                  label="Installation"
                  name="github_installation_id"
                  rules={[{ required: true, message: 'Select a GitHub App installation' }]}
                  tooltip="Choose which org or account this channel monitors"
                >
                  <Select placeholder="Select an installation">
                    {githubInstallations.map((inst) => (
                      <Select.Option key={inst.id} value={inst.id}>
                        <Space>
                          {inst.account?.avatar_url && (
                            <img
                              src={inst.account.avatar_url}
                              alt=""
                              style={{ width: 16, height: 16, borderRadius: 2 }}
                            />
                          )}
                          {inst.account?.login || `Installation #${inst.id}`}
                          <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                            ({inst.repository_selection === 'all' ? 'all repos' : 'selected repos'})
                          </Typography.Text>
                        </Space>
                      </Select.Option>
                    ))}
                  </Select>
                </Form.Item>
              )}

              <Button
                type="primary"
                disabled={githubInstallations.length === 0}
                onClick={() => onGithubStepChange(2)}
                style={{ marginTop: 8 }}
              >
                Next: Configure Channel
              </Button>
            </div>
          )}

          {/* Step 2: Configuration */}
          {githubStep === 2 && !githubLoading && (
            <Collapse
              ghost
              defaultActiveKey={mode === 'create' ? ['github-config'] : []}
              style={{ marginLeft: -16, marginRight: -16 }}
              items={[
                {
                  key: 'github-config',
                  label: (
                    <SectionLabel
                      icon={<GithubOutlined />}
                      title="GitHub Settings"
                      subtitle="polling & mentions"
                    />
                  ),
                  children: (
                    <>
                      <Form.Item
                        label="Watch Repos"
                        name="github_watch_repos"
                        tooltip="Repos to watch for @mentions. Leave empty to watch all repos accessible to the installation."
                      >
                        <Select
                          mode="tags"
                          placeholder="owner/repo (leave empty for all)"
                          tokenSeparators={[',', ' ']}
                        />
                      </Form.Item>

                      <Form.Item
                        label="Require @mention"
                        name="github_require_mention"
                        valuePropName="checked"
                        initialValue={true}
                        tooltip="Only respond to PR/issue comments that @mention the bot"
                      >
                        <Switch />
                      </Form.Item>

                      <Form.Item
                        label="Mention Name"
                        name="github_mention_name"
                        tooltip="The name users type to trigger the bot (e.g., 'agor' for @agor)"
                        initialValue="agor"
                      >
                        <Input prefix="@" placeholder="agor" />
                      </Form.Item>

                      <Form.Item
                        label="Poll Interval (seconds)"
                        name="github_poll_interval_s"
                        initialValue={30}
                        tooltip="How frequently to poll the GitHub API for new mentions"
                      >
                        <InputNumber min={10} max={300} style={{ width: '100%' }} />
                      </Form.Item>
                    </>
                  ),
                },
                // ── Agentic Tool Configuration ──
                {
                  key: 'agentic-tool-config',
                  label: (
                    <SectionLabel
                      icon={<ThunderboltOutlined />}
                      title="Agent Configuration"
                      subtitle={selectedAgent}
                    />
                  ),
                  children: (
                    <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Configure which agent and settings to use for sessions created from this
                        channel.
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
            />
          )}
        </>
      )}

      {/* ── Collapsible sections (Slack only) ── */}
      {channelType === 'slack' && (
        <Collapse
          ghost
          defaultActiveKey={mode === 'create' ? ['credentials'] : []}
          style={{ marginLeft: -16, marginRight: -16 }}
          items={[
            // ── Credentials ──
            {
              key: 'credentials',
              label: (
                <SectionLabel
                  icon={<KeyOutlined />}
                  title="Credentials"
                  subtitle={mode === 'edit' ? 'leave blank to keep current' : undefined}
                />
              ),
              children: (
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
                    label="Bot Token"
                    name="bot_token"
                    rules={
                      mode === 'create'
                        ? [{ required: true, message: 'Bot token is required' }]
                        : []
                    }
                    tooltip="Slack Bot User OAuth Token (xoxb-...)"
                  >
                    <Input.Password placeholder={mode === 'edit' ? '••••••••' : 'xoxb-...'} />
                  </Form.Item>

                  <Form.Item
                    label="App Token"
                    name="app_token"
                    rules={
                      mode === 'create'
                        ? [{ required: true, message: 'App token is required' }]
                        : []
                    }
                    tooltip="Slack App-Level Token for Socket Mode (xapp-...)"
                  >
                    <Input.Password placeholder={mode === 'edit' ? '••••••••' : 'xapp-...'} />
                  </Form.Item>

                  <Alert
                    type="info"
                    showIcon
                    message="Socket Mode Required"
                    description="Enable Socket Mode in your Slack app settings and generate an app-level token with connections:write scope."
                    style={{ fontSize: 12 }}
                  />
                </>
              ),
            },

            // ── Message Sources ──
            {
              key: 'message-sources',
              label: (
                <SectionLabel
                  icon={<MessageOutlined />}
                  title="Message Sources"
                  subtitle="DMs always enabled"
                />
              ),
              children: (
                <>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 16 }}
                  >
                    Choose where the bot listens for messages. Direct messages are always enabled.
                  </Typography.Text>

                  <Form.Item
                    label="Public Channels"
                    name="enable_channels"
                    valuePropName="checked"
                    initialValue={false}
                    tooltip="Bot will respond to messages in public channels it's added to"
                  >
                    <Switch />
                  </Form.Item>

                  <Form.Item
                    label="Private Channels"
                    name="enable_groups"
                    valuePropName="checked"
                    initialValue={false}
                    tooltip="Bot will respond to messages in private channels it's added to"
                  >
                    <Switch />
                  </Form.Item>

                  <Form.Item
                    label="Group DMs"
                    name="enable_mpim"
                    valuePropName="checked"
                    initialValue={false}
                    tooltip="Bot will respond to messages in multi-person direct messages"
                  >
                    <Switch />
                  </Form.Item>

                  <Form.Item
                    label="Require @mention"
                    name="require_mention"
                    valuePropName="checked"
                    initialValue={true}
                    tooltip="When enabled, bot only responds when explicitly @mentioned (recommended for channels)"
                  >
                    <Switch />
                  </Form.Item>

                  {sourcesEnabled && !requireMention && (
                    <Alert
                      type="warning"
                      showIcon
                      message="Bot will respond to ALL messages in enabled channels. This can be noisy and expensive."
                      style={{ marginBottom: 12 }}
                    />
                  )}

                  {sourcesEnabled && (
                    <Alert
                      type="info"
                      showIcon
                      message="Required Slack Scopes & Events"
                      description={
                        <ul style={{ margin: '8px 0 0 0', paddingLeft: 20, fontSize: 12 }}>
                          <li>
                            <code>chat:write</code> (always required)
                          </li>
                          {enableChannels && (
                            <>
                              <li>
                                <code>channels:history</code> + <code>app_mentions:read</code>
                              </li>
                              <li>
                                Events: <code>message.channels</code>, <code>app_mention</code>
                              </li>
                            </>
                          )}
                          {enableGroups && (
                            <li>
                              <code>groups:history</code> + event: <code>message.groups</code>
                            </li>
                          )}
                          {enableMpim && (
                            <li>
                              <code>mpim:history</code> + event: <code>message.mpim</code>
                            </li>
                          )}
                        </ul>
                      }
                      style={{ fontSize: 12 }}
                    />
                  )}
                </>
              ),
            },

            // ── User Alignment ──
            {
              key: 'user-alignment',
              label: (
                <SectionLabel
                  icon={<TeamOutlined />}
                  title="User Alignment"
                  subtitle={alignSlackUsers ? 'enabled' : 'disabled'}
                />
              ),
              children: (
                <>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 16 }}
                  >
                    When enabled, messages are attributed to the Agor user whose email matches the
                    Slack user&apos;s email. Users without a matching Agor account are rejected.
                  </Typography.Text>

                  <Form.Item
                    label="Align Slack Users with Agor Users"
                    name="align_slack_users"
                    valuePropName="checked"
                    initialValue={false}
                  >
                    <Switch />
                  </Form.Item>

                  {alignSlackUsers && (
                    <Alert
                      type="info"
                      showIcon
                      message="Requires users:read.email scope"
                      description={
                        <span>
                          Add <code>users:read.email</code> to your Slack app to look up user
                          emails. Without this scope, alignment silently falls back to the
                          configured &quot;Post messages as&quot; user.
                        </span>
                      }
                      style={{ fontSize: 12 }}
                    />
                  )}
                </>
              ),
            },

            // ── Advanced ──
            {
              key: 'advanced',
              label: (
                <SectionLabel
                  icon={<ToolOutlined />}
                  title="Advanced"
                  subtitle="channel whitelist"
                />
              ),
              children: (
                <>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
                  >
                    Restrict the bot to specific Slack channels by ID. Leave empty to allow all
                    channels. Find channel IDs: right-click channel &rarr; View channel details
                    &rarr; scroll to bottom.
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
                </>
              ),
            },

            // ── Agentic Tool Configuration ──
            {
              key: 'agentic-tool-config',
              label: (
                <SectionLabel
                  icon={<ThunderboltOutlined />}
                  title="Agent Configuration"
                  subtitle={selectedAgent}
                />
              ),
              children: (
                <Space orientation="vertical" size="middle" style={{ width: '100%' }}>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    Configure which agent and settings to use for sessions created from this
                    channel.
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
        />
      )}
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

  // ── GitHub App Setup State (lifted from ChannelFormFields) ──
  const [githubStep, setGithubStep] = useState(0);
  const [githubCredentials, setGithubCredentials] = useState<GitHubSetupCredentials | null>(null);
  const [githubInstallations, setGithubInstallations] = useState<GitHubInstallation[]>([]);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubSetupParams, setGithubSetupParams] = useState<GitHubSetupParams | null>(null);

  // Detect GitHub setup callback params from URL
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const setupToken = params.get('setup_token');
    const appId = params.get('app_id');
    const slug = params.get('slug');
    const owner = params.get('owner');
    const htmlUrl = params.get('html_url');

    if (setupToken && appId && slug && owner && htmlUrl) {
      setGithubSetupParams({
        setup_token: setupToken,
        app_id: appId,
        slug,
        owner,
        html_url: htmlUrl,
      });
      setChannelType('github');
      setCreateModalOpen(true);
      // Clean up URL params — navigate to root since /gateway/github/setup isn't a real route
      navigate('/', { replace: true });
    }
  }, [location.search, navigate]);

  // Fetch GitHub credentials when setup params arrive
  useEffect(() => {
    if (!githubSetupParams?.setup_token) return;

    const fetchSetup = async () => {
      setGithubLoading(true);
      setGithubError(null);
      try {
        const daemonUrl = getDaemonUrl();
        const credRes = await fetch(
          `${daemonUrl}/api/github/setup/${githubSetupParams.setup_token}`
        );
        if (!credRes.ok) throw new Error('Setup token expired or invalid');
        const creds = (await credRes.json()) as GitHubSetupCredentials;
        setGithubCredentials(creds);

        const instRes = await fetch(
          `${daemonUrl}/api/github/installations?app_id=${creds.app_id}&setup_token=${githubSetupParams.setup_token}`
        );
        if (instRes.ok) {
          const instData = (await instRes.json()) as { installations: GitHubInstallation[] };
          setGithubInstallations(instData.installations);
        }

        createForm.setFieldsValue({
          name: `GitHub: ${creds.owner}/${creds.slug}`,
          channel_type: 'github',
        });

        setGithubStep(1);
      } catch (err) {
        setGithubError(err instanceof Error ? err.message : 'Failed to load setup data');
      } finally {
        setGithubLoading(false);
      }
    };

    fetchSetup();
  }, [githubSetupParams, createForm]);

  const resetGithubState = useCallback(() => {
    setGithubStep(0);
    setGithubCredentials(null);
    setGithubInstallations([]);
    setGithubLoading(false);
    setGithubError(null);
    setGithubSetupParams(null);
  }, []);

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
    // Strip redacted sentinel values from existingConfig so they're never sent
    // back to the server. The API redacts tokens to '••••••••' — if we spread
    // that into the config object, the backend would save the sentinel as the
    // actual token (wiping the real credentials).
    const SENSITIVE_FIELDS = ['bot_token', 'app_token', 'signing_secret', 'private_key'];
    const sanitizedExisting = { ...(existingConfig || {}) };
    for (const field of SENSITIVE_FIELDS) {
      delete sanitizedExisting[field];
    }
    const config: Record<string, unknown> = { ...sanitizedExisting };
    if (values.channel_type === 'github') {
      // GitHub App credentials from the manifest flow
      if (githubCredentials) {
        config.app_id = githubCredentials.app_id;
        config.private_key = githubCredentials.pem;
        config.webhook_secret = githubCredentials.webhook_secret;
        config.owner = githubCredentials.owner;
      }
      if (values.github_installation_id) {
        config.installation_id = values.github_installation_id;
      }
      config.watch_repos = values.github_watch_repos ?? [];
      config.require_mention = values.github_require_mention ?? true;
      config.mention_name = values.github_mention_name || 'agor';
      config.poll_interval_ms = ((values.github_poll_interval_s as number) ?? 30) * 1000;
    } else if (values.channel_type === 'slack') {
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
      resetGithubState();
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

    const formValues: Record<string, unknown> = {
      name: channel.name,
      channel_type: channel.channel_type,
      target_worktree_id: channel.target_worktree_id,
      agor_user_id: channel.agor_user_id,
      enabled: channel.enabled,
      // Agentic config fields
      permissionMode: channel.agentic_config?.permissionMode,
      modelConfig: channel.agentic_config?.modelConfig,
      mcpServerIds: channel.agentic_config?.mcpServerIds,
      codexSandboxMode: channel.agentic_config?.codexSandboxMode,
      codexApprovalPolicy: channel.agentic_config?.codexApprovalPolicy,
      codexNetworkAccess: channel.agentic_config?.codexNetworkAccess,
    };

    if (channel.channel_type === 'slack') {
      formValues.connection_mode = config?.connection_mode || 'socket';
      formValues.enable_channels = config?.enable_channels ?? false;
      formValues.enable_groups = config?.enable_groups ?? false;
      formValues.enable_mpim = config?.enable_mpim ?? false;
      formValues.require_mention = config?.require_mention ?? true;
      formValues.align_slack_users = config?.align_slack_users ?? false;
      formValues.allowed_channel_ids = (config?.allowed_channel_ids as string[]) ?? [];
    } else if (channel.channel_type === 'github') {
      formValues.github_installation_id = config?.installation_id;
      formValues.github_watch_repos = (config?.watch_repos as string[]) ?? [];
      formValues.github_require_mention = config?.require_mention ?? true;
      formValues.github_mention_name = (config?.mention_name as string) || 'agor';
      formValues.github_poll_interval_s = ((config?.poll_interval_ms as number) ?? 30000) / 1000;
    }

    editForm.setFieldsValue(formValues);
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
    const success = await copyToClipboard(key);
    if (success) {
      showSuccess('Channel key copied to clipboard');
    } else {
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

  const channels = mapToSortedArray(gatewayChannelById, (a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  );

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
          Route messages from Slack, GitHub, and other platforms to Agor sessions.
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
          resetGithubState();
        }}
        okText="Create"
        okButtonProps={{
          // Hide the Create button when GitHub setup hasn't reached the config step
          style: channelType === 'github' && githubStep < 2 ? { display: 'none' } : undefined,
        }}
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
            githubStep={githubStep}
            onGithubStepChange={setGithubStep}
            githubCredentials={githubCredentials}
            githubInstallations={githubInstallations}
            githubLoading={githubLoading}
            githubError={githubError}
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
            githubStep={2}
            onGithubStepChange={() => {}}
            githubCredentials={null}
            githubInstallations={[]}
            githubLoading={false}
            githubError={null}
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
                <Space orientation="vertical" style={{ width: '100%' }}>
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
            {createdChannelType === 'github' && (
              <Alert
                message="GitHub Channel Ready"
                description={
                  <ol style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                    <li>The GitHub App is connected and polling will begin automatically</li>
                    <li>
                      Use <code>@agor</code> (or your configured mention name) in PR or issue
                      comments to trigger the bot
                    </li>
                    <li>
                      Agor will create a session for each conversation and respond in-line on GitHub
                    </li>
                    <li>
                      No webhooks needed — Agor polls the GitHub API on the configured interval
                    </li>
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
