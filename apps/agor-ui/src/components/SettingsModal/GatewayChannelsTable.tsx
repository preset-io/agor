import type {
  AgenticToolName,
  AgorClient,
  ChannelType,
  GatewayAgenticConfig,
  GatewayChannel,
  GatewayEnvVar,
  MCPServer,
  PermissionMode,
  User,
  UUID,
  Worktree,
} from '@agor-live/client';
import {
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  GithubOutlined,
  KeyOutlined,
  LoadingOutlined,
  LockOutlined,
  MessageOutlined,
  PlusOutlined,
  SlackOutlined,
  TeamOutlined,
  ThunderboltOutlined,
  ToolOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  Collapse,
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
  Tooltip,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getDaemonUrl } from '@/config/daemon';
import { copyToClipboard } from '@/utils/clipboard';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { WorktreeSelect } from './WorktreeSelect';

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
// Environment Variables Editor
// ============================================================================

/**
 * Inline editor for gateway-level environment variables.
 * Stored as GatewayEnvVar[] in agentic_config.envVars.
 */
const GatewayEnvVarsEditor: React.FC<{
  value?: GatewayEnvVar[];
  onChange?: (vars: GatewayEnvVar[]) => void;
}> = ({ value = [], onChange }) => {
  // Stable row IDs so React doesn't remount inputs on every keystroke.
  // Each row gets a monotonically increasing ID that persists across re-renders.
  const nextId = useRef(0);
  const rowIds = useRef<number[]>([]);
  // Sync rowIds length with value length (handles external additions/removals)
  while (rowIds.current.length < value.length) {
    rowIds.current.push(nextId.current++);
  }
  if (rowIds.current.length > value.length) {
    rowIds.current.length = value.length;
  }

  const addVar = () => {
    rowIds.current.push(nextId.current++);
    onChange?.([...value, { key: '', value: '', forceOverride: false }]);
  };

  const updateVar = (index: number, field: keyof GatewayEnvVar, newValue: string | boolean) => {
    const updated = value.map((v, i) => (i === index ? { ...v, [field]: newValue } : v));
    onChange?.(updated);
  };

  const removeVar = (index: number) => {
    rowIds.current.splice(index, 1);
    onChange?.(value.filter((_, i) => i !== index));
  };

  return (
    <div>
      {value.map((envVar, index) => (
        <div
          key={rowIds.current[index]}
          style={{
            display: 'flex',
            gap: 8,
            marginBottom: 8,
            alignItems: 'flex-start',
          }}
        >
          <Input
            placeholder="KEY_NAME"
            value={envVar.key}
            onChange={(e) => updateVar(index, 'key', e.target.value)}
            style={{ flex: '0 0 160px', fontFamily: 'monospace', fontSize: 12 }}
          />
          {envVar.value === '••••••••' ? (
            <Input
              placeholder="click to replace value"
              value=""
              onFocus={() => updateVar(index, 'value', '')}
              readOnly
              style={{
                flex: 1,
                fontFamily: 'monospace',
                fontSize: 12,
                color: 'transparent',
                textShadow: '0 0 6px rgba(255,255,255,0.5)',
              }}
            />
          ) : (
            <Input.Password
              placeholder="value"
              value={envVar.value}
              onChange={(e) => updateVar(index, 'value', e.target.value)}
              style={{ flex: 1, fontFamily: 'monospace', fontSize: 12 }}
            />
          )}
          <Tooltip title="Force override: always use this value, even if the user has their own">
            <Checkbox
              checked={envVar.forceOverride}
              onChange={(e) => updateVar(index, 'forceOverride', e.target.checked)}
              style={{ marginTop: 5 }}
            >
              <Typography.Text style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
                Force
              </Typography.Text>
            </Checkbox>
          </Tooltip>
          <Button
            type="text"
            size="small"
            icon={<DeleteOutlined />}
            danger
            onClick={() => removeVar(index)}
            style={{ marginTop: 2 }}
          />
        </div>
      ))}
      <Button type="dashed" size="small" icon={<PlusOutlined />} onClick={addVar} block>
        Add Variable
      </Button>
      {value.length > 0 && (
        <Typography.Text type="secondary" style={{ fontSize: 11, display: 'block', marginTop: 8 }}>
          <LockOutlined style={{ marginRight: 4 }} />
          <strong>Fallback</strong> (default): used only when the user hasn&apos;t set this key.{' '}
          <strong>Force</strong>: always overrides the user&apos;s value.
        </Typography.Text>
      )}
    </div>
  );
};

// ============================================================================
// GitHub App Setup Types & Helpers
// ============================================================================

/** Credentials fetched from the daemon after GitHub App manifest creation */
/** Parameters passed via URL from the GitHub App setup callback */
interface GitHubSetupParams {
  installation_id?: string;
}

/** GitHub setup wizard steps */
const GITHUB_SETUP_STEPS = [
  { title: 'Create App' },
  { title: 'Credentials' },
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
  githubSetupParams: GitHubSetupParams | null;
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
  githubSetupParams,
  githubLoading,
  githubError,
}) => {
  // Watch message source settings for showing warnings/scope requirements
  const enableChannels = Form.useWatch('enable_channels', form) ?? false;
  const enableGroups = Form.useWatch('enable_groups', form) ?? false;
  const enableMpim = Form.useWatch('enable_mpim', form) ?? false;
  const requireMention = Form.useWatch('require_mention', form) ?? true;
  const alignSlackUsers = Form.useWatch('align_slack_users', form) ?? false;
  const alignGithubUsers = Form.useWatch('github_align_users', form) ?? false;

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
        <WorktreeSelect worktreeById={worktreeById} />
      </Form.Item>

      {/* For GitHub channels, "Post messages as" lives in the User Alignment section */}
      {channelType !== 'github' && (
        <Form.Item
          label="Post messages as"
          name="agor_user_id"
          rules={[{ required: true, message: 'Please select a user' }]}
          tooltip="Sessions from this channel will run as this Agor user"
        >
          <Select placeholder="Select a user" showSearch optionFilterProp="children">
            {Array.from(userById.values())
              .sort((a, b) =>
                (a.name || a.email || a.user_id).localeCompare(b.name || b.email || b.user_id)
              )
              .map((u) => (
                <Select.Option key={u.user_id} value={u.user_id}>
                  {u.name || u.email || u.user_id}
                </Select.Option>
              ))}
          </Select>
        </Form.Item>
      )}

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
                  window.open(`${daemonUrl}/api/github/setup/new${qs ? `?${qs}` : ''}`, '_blank');
                }}
              >
                Create GitHub App on GitHub
              </Button>

              <Button
                type="default"
                block
                onClick={() => onGithubStepChange(1)}
                style={{ marginTop: 12 }}
              >
                I&apos;ve created the app — enter credentials
              </Button>
            </div>
          )}

          {/* Step 1: Installation Picker */}
          {githubStep >= 1 && !githubLoading && (
            <div style={{ marginBottom: 16, display: githubStep === 1 ? undefined : 'none' }}>
              <Alert
                type="info"
                showIcon
                message="Enter your GitHub App credentials"
                description={
                  <span>
                    On your GitHub App&apos;s settings page:
                    <br />
                    1. Copy the <strong>App ID</strong> (shown at the top under &quot;About&quot;)
                    <br />
                    2. Scroll to &quot;Private keys&quot; and click{' '}
                    <strong>&quot;Generate a private key&quot;</strong>
                    <br />
                    3. Paste the downloaded .pem file contents below
                  </span>
                }
                style={{ marginBottom: 16 }}
              />

              <Form.Item
                label="App ID"
                name="github_app_id"
                tooltip="Found on your GitHub App's settings page (General → About)"
              >
                <Input placeholder="123456" />
              </Form.Item>

              <Form.Item
                label="Private Key (PEM)"
                name="github_private_key"
                tooltip="Generate a private key on your GitHub App's settings page, then paste the .pem file contents"
              >
                <Input.TextArea
                  rows={4}
                  placeholder="-----BEGIN RSA PRIVATE KEY-----&#10;..."
                  style={{ fontFamily: 'monospace', fontSize: 11 }}
                />
              </Form.Item>

              <Form.Item
                label="Installation ID"
                name="github_installation_id"
                tooltip="Set automatically via the setup callback, or paste from your GitHub App's installation URL"
              >
                <Input placeholder="123456789" />
              </Form.Item>

              {githubError && (
                <Alert type="error" showIcon message={githubError} style={{ marginBottom: 12 }} />
              )}

              <Button
                type="primary"
                onClick={() => {
                  const appId = form.getFieldValue('github_app_id');
                  const pem = form.getFieldValue('github_private_key');
                  if (!appId || !pem) {
                    const errors: { name: string; errors: string[] }[] = [];
                    if (!appId)
                      errors.push({ name: 'github_app_id', errors: ['Enter your GitHub App ID'] });
                    if (!pem)
                      errors.push({
                        name: 'github_private_key',
                        errors: ['Paste your GitHub App private key'],
                      });
                    form.setFields(errors);
                    return;
                  }
                  onGithubStepChange(2);
                }}
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
              destroyOnHidden={false}
              defaultActiveKey={mode === 'create' ? ['github-config'] : []}
              style={{ marginLeft: -16, marginRight: -16 }}
              items={[
                // ── Credentials (edit mode) ──
                ...(mode === 'edit'
                  ? [
                      {
                        key: 'github-credentials',
                        label: (
                          <SectionLabel
                            icon={<GithubOutlined />}
                            title="App Credentials"
                            subtitle={
                              editingChannel?.config &&
                              (editingChannel.config as Record<string, unknown>).private_key
                                ? 'configured'
                                : 'not set'
                            }
                          />
                        ),
                        children: (
                          <>
                            <Form.Item
                              label="App ID"
                              name="github_app_id"
                              tooltip="Found on your GitHub App's settings page (General → About)"
                            >
                              <Input placeholder="123456" />
                            </Form.Item>
                            <Form.Item
                              label="Private Key (PEM)"
                              name="github_private_key"
                              tooltip="Leave empty to keep the existing key. Paste a new .pem to replace it."
                            >
                              <Input.TextArea
                                rows={3}
                                placeholder={
                                  editingChannel?.config &&
                                  (editingChannel.config as Record<string, unknown>).private_key
                                    ? '(private key is set — paste new key to replace)'
                                    : '-----BEGIN RSA PRIVATE KEY-----\n...'
                                }
                                style={{ fontFamily: 'monospace', fontSize: 11 }}
                              />
                            </Form.Item>
                            <Form.Item
                              label="Installation ID"
                              name="github_installation_id"
                              tooltip="Set automatically via the setup callback, or paste from your GitHub App's installation URL"
                            >
                              <Input placeholder="123456789" />
                            </Form.Item>
                          </>
                        ),
                      },
                    ]
                  : []),
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
                        rules={[{ required: true, message: 'At least one repo is required' }]}
                        tooltip="Repos to watch for @mentions, in owner/repo format"
                      >
                        <Select
                          mode="tags"
                          placeholder="preset-io/agor"
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
                // ── User Alignment ──
                {
                  key: 'user-alignment',
                  label: (
                    <SectionLabel
                      icon={<UserOutlined />}
                      title="User Alignment"
                      subtitle="Map GitHub users to Agor accounts"
                    />
                  ),
                  children: (
                    <>
                      <Form.Item
                        label="Enable User Alignment"
                        name="github_align_users"
                        valuePropName="checked"
                        initialValue={false}
                        tooltip="When enabled, GitHub users are mapped to Agor users. Unmapped users are rejected."
                      >
                        <Switch />
                      </Form.Item>
                      {alignGithubUsers ? (
                        <Form.Item
                          label="User Map"
                          name="github_user_map"
                          tooltip="JSON object mapping GitHub logins to Agor email addresses"
                          rules={[{ validator: validateJSON }]}
                        >
                          <JSONEditor
                            rows={4}
                            placeholder={'{\n  "octocat": "user@example.com"\n}'}
                          />
                        </Form.Item>
                      ) : (
                        <Form.Item
                          label="Post messages as"
                          name="agor_user_id"
                          rules={[{ required: true, message: 'Please select a user' }]}
                          tooltip="All sessions from this channel will run as this Agor user"
                        >
                          <Select
                            placeholder="Select a user"
                            showSearch
                            optionFilterProp="children"
                          >
                            {Array.from(userById.values())
                              .sort((a, b) =>
                                (a.name || a.email || a.user_id).localeCompare(
                                  b.name || b.email || b.user_id
                                )
                              )
                              .map((u) => (
                                <Select.Option key={u.user_id} value={u.user_id}>
                                  {u.name || u.email || u.user_id}
                                </Select.Option>
                              ))}
                          </Select>
                        </Form.Item>
                      )}
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
                // ── Environment Variables ──
                {
                  key: 'env-vars',
                  label: (
                    <SectionLabel
                      icon={<LockOutlined />}
                      title="Environment Variables"
                      subtitle="channel-level secrets"
                    />
                  ),
                  children: (
                    <>
                      <Typography.Text
                        type="secondary"
                        style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
                      >
                        Define environment variables for sessions created from this channel. Useful
                        for service account tokens or API keys for MCP servers.
                      </Typography.Text>
                      <Form.Item name="envVars" noStyle>
                        <GatewayEnvVarsEditor />
                      </Form.Item>
                    </>
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
          destroyOnHidden={false}
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
            // ── Environment Variables ──
            {
              key: 'env-vars',
              label: (
                <SectionLabel
                  icon={<LockOutlined />}
                  title="Environment Variables"
                  subtitle="channel-level secrets"
                />
              ),
              children: (
                <>
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
                  >
                    Define environment variables for sessions created from this channel. Useful for
                    service account tokens or API keys for MCP servers.
                  </Typography.Text>
                  <Form.Item name="envVars" noStyle>
                    <GatewayEnvVarsEditor />
                  </Form.Item>
                </>
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
  const [referencedWorktreesById, setReferencedWorktreesById] = useState<Map<string, Worktree>>(
    () => new Map()
  );
  const loadingReferencedWorktreeIds = useRef<Set<string>>(new Set());
  const referencedWorktreesByIdRef = useRef<Map<string, Worktree>>(new Map());

  // ── GitHub App Setup State (lifted from ChannelFormFields) ──
  const [githubStep, setGithubStep] = useState(0);
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);
  const [githubSetupParams, setGithubSetupParams] = useState<GitHubSetupParams | null>(null);

  // Detect GitHub setup callback params from URL
  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const params = new URLSearchParams(location.search);
    const installationId = params.get('installation_id');

    if (installationId) {
      setGithubSetupParams({ installation_id: installationId });
      setChannelType('github');
      setGithubStep(1); // Skip to credentials step since app is already created
      setCreateModalOpen(true);
      // Clean up URL params
      navigate('/', { replace: true });
    }
  }, [location.search, navigate]);

  // Keep referenced target worktrees resolvable in CRUD even when archived worktrees
  // are excluded from the core store.
  useEffect(() => {
    referencedWorktreesByIdRef.current = referencedWorktreesById;
  }, [referencedWorktreesById]);

  useEffect(() => {
    if (!client) return;

    const targetIds = new Set<string>();
    for (const channel of gatewayChannelById.values()) {
      if (channel.target_worktree_id) {
        targetIds.add(channel.target_worktree_id);
      }
    }

    const missingIds = Array.from(targetIds).filter(
      (id) => !worktreeById.has(id) && !referencedWorktreesByIdRef.current.has(id)
    );
    if (missingIds.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missingIds.map(async (id) => {
        if (loadingReferencedWorktreeIds.current.has(id)) return null;
        loadingReferencedWorktreeIds.current.add(id);
        try {
          const worktree = (await client.service('worktrees').get(id)) as Worktree;
          return worktree;
        } catch {
          return null;
        } finally {
          loadingReferencedWorktreeIds.current.delete(id);
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const resolved = results.filter((wt): wt is Worktree => wt !== null);
      if (resolved.length === 0) return;

      setReferencedWorktreesById((prev) => {
        const next = new Map(prev);
        for (const wt of resolved) {
          next.set(wt.worktree_id, wt);
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [client, gatewayChannelById, worktreeById]);

  const worktreeOptionsById = useMemo(() => {
    const merged = new Map<string, Worktree>();
    for (const wt of worktreeById.values()) {
      merged.set(wt.worktree_id, wt);
    }
    for (const wt of referencedWorktreesById.values()) {
      if (!merged.has(wt.worktree_id)) {
        merged.set(wt.worktree_id, wt);
      }
    }
    return merged;
  }, [referencedWorktreesById, worktreeById]);

  // No automatic credential fetch — user provides App ID and PEM manually

  const resetGithubState = useCallback(() => {
    setGithubStep(0);
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
      // GitHub App credentials from form input
      if (values.github_app_id) {
        config.app_id = Number(values.github_app_id);
      }
      if (values.github_private_key) {
        config.private_key = values.github_private_key;
      }
      if (values.github_installation_id) {
        config.installation_id = Number(values.github_installation_id);
      }
      // Form has preserve={true}, so all values are available even from collapsed panels.
      config.watch_repos = values.github_watch_repos ?? [];
      config.require_mention = values.github_require_mention ?? true;
      config.mention_name = values.github_mention_name || 'agor';
      config.poll_interval_ms = ((values.github_poll_interval_s as number) ?? 30) * 1000;
      config.align_github_users = values.github_align_users ?? false;
      if (values.github_user_map) {
        try {
          config.user_map = JSON.parse(values.github_user_map as string);
        } catch {
          // validateJSON rule handles the error display
        }
      }
    } else if (values.channel_type === 'slack') {
      if (values.bot_token) config.bot_token = values.bot_token;
      if (values.app_token) config.app_token = values.app_token;
      if (values.connection_mode) config.connection_mode = values.connection_mode;

      // Form has preserve={true}, so all values are available even from collapsed panels.
      config.enable_channels = values.enable_channels ?? false;
      config.enable_groups = values.enable_groups ?? false;
      config.enable_mpim = values.enable_mpim ?? false;
      config.require_mention = values.require_mention ?? true;
      config.align_slack_users = values.align_slack_users ?? false;
      config.allowed_channel_ids = values.allowed_channel_ids ?? [];
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
      // Include env vars — filter out empty-key entries only.
      // Sentinel values ('••••••••') are sent through so the backend can
      // substitute real values from the database. Empty array = delete all.
      ...(values.envVars !== undefined
        ? {
            envVars: (values.envVars as GatewayEnvVar[]).filter((v) => v.key.trim() !== ''),
          }
        : {}),
    };

    // Form has preserve={true}, so agor_user_id is retained even when the
    // "Post messages as" dropdown is hidden (GitHub alignment ON).
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
      await createForm.validateFields();
      // Use getFieldsValue(true) to include values from collapsed (unmounted)
      // panels that validateFields() may omit.
      const values = createForm.getFieldsValue(true);
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
      // Env vars: values are masked by the API, so on edit we show the
      // existing keys with empty values — the user re-enters values to update.
      envVars: channel.agentic_config?.envVars ?? [],
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
      formValues.github_app_id = config?.app_id;
      formValues.github_installation_id = config?.installation_id;
      formValues.github_watch_repos = (config?.watch_repos as string[]) ?? [];
      formValues.github_require_mention = config?.require_mention ?? true;
      formValues.github_mention_name = (config?.mention_name as string) || 'agor';
      formValues.github_poll_interval_s = ((config?.poll_interval_ms as number) ?? 30000) / 1000;
      formValues.github_align_users = config?.align_github_users ?? false;
      const userMap = config?.user_map as Record<string, string> | undefined;
      if (userMap && typeof userMap === 'object' && Object.keys(userMap).length > 0) {
        formValues.github_user_map = JSON.stringify(userMap, null, 2);
      }
    }

    editForm.setFieldsValue(formValues);
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingChannel) return;
    editForm
      .validateFields()
      .then(() => {
        // Use getFieldsValue(true) to include values from collapsed (unmounted)
        // panels that validateFields() may omit.
        const values = editForm.getFieldsValue(true);
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
        const wt = worktreeOptionsById.get(worktreeId);
        return (
          <Typography.Text type="secondary">
            {wt
              ? `${wt.name || wt.ref || worktreeId}${wt.archived ? ' (archived)' : ''}`
              : worktreeId}
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
        <Form form={createForm} layout="vertical" preserve style={{ marginTop: 16 }}>
          <ChannelFormFields
            form={createForm}
            mode="create"
            channelType={channelType}
            onChannelTypeChange={setChannelType}
            worktreeById={worktreeOptionsById}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
            githubStep={githubStep}
            onGithubStepChange={setGithubStep}
            githubSetupParams={githubSetupParams}
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
        <Form form={editForm} layout="vertical" preserve style={{ marginTop: 16 }}>
          <ChannelFormFields
            form={editForm}
            mode="edit"
            channelType={channelType}
            onChannelTypeChange={setChannelType}
            worktreeById={worktreeOptionsById}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
            editingChannel={editingChannel}
            onCopyKey={handleCopyKey}
            githubStep={2}
            onGithubStepChange={() => {}}
            githubSetupParams={null}
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
