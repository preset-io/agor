// Import the manifest helpers from the connector-free subpath so the browser
// bundle never pulls in @slack/web-api / @slack/socket-mode (node-only) via the
// gateway barrel.
import {
  buildSlackManifest,
  requiredBotEvents,
  requiredBotScopes,
  type SlackWizardOptions,
} from '@agor/core/gateway/slack-manifest';
import type {
  AgenticToolName,
  AgorClient,
  Branch,
  ChannelType,
  GatewayAgenticConfig,
  GatewayChannel,
  GatewayEnvVar,
  MCPServer,
  PermissionMode,
  SlackTestResult,
  User,
  UUID,
} from '@agor-live/client';
import { GATEWAY_REDACTED_SENTINEL } from '@agor-live/client';
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  CopyOutlined,
  DeleteOutlined,
  EditOutlined,
  ExclamationCircleOutlined,
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
  Radio,
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
import { getDaemonUrl } from '@/config/daemon';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { ACCESS_TOKEN_KEY } from '@/utils/tokenRefresh';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import { HighlightMatch } from '../HighlightMatch';
import { JSONEditor, validateJSON } from '../JSONEditor';
import { BranchSelect } from './BranchSelect';
import { SettingsActionGroup } from './SettingsActionGroup';
import { UserSelect } from './UserSelect';

interface GatewayChannelsTableProps {
  client: AgorClient | null;
  gatewayChannelById: Map<string, GatewayChannel>;
  branchById: Map<string, Branch>;
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
  { value: 'teams', label: 'Microsoft Teams', icon: <TeamOutlined /> },
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
    case 'teams':
      return <TeamOutlined />;
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
    case 'teams':
      return 'geekblue';
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

const getIdentitySubtitle = (alignUsers: boolean): string =>
  alignUsers ? 'align users' : 'run as selected user';

const PlatformIdentityFields: React.FC<{
  alignFieldName: string;
  alignLabel: string;
  alignDescription: string;
  alignUsers: boolean;
  alignedContent: React.ReactNode;
  userById: Map<string, User>;
}> = ({ alignFieldName, alignLabel, alignDescription, alignUsers, alignedContent, userById }) => (
  <>
    <Typography.Text type="secondary" style={{ fontSize: 12, display: 'block', marginBottom: 12 }}>
      Choose which Agor user identity gateway-created sessions run as.
    </Typography.Text>

    <Form.Item name={alignFieldName} initialValue={false}>
      <Radio.Group style={{ width: '100%' }}>
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Radio value={true}>
            <Space orientation="vertical" size={0}>
              <Typography.Text>{alignLabel}</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {alignDescription}
              </Typography.Text>
            </Space>
          </Radio>
          <Radio value={false}>
            <Space orientation="vertical" size={0}>
              <Typography.Text>Run as selected user</Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Every message uses one configured Agor user.
              </Typography.Text>
            </Space>
          </Radio>
        </Space>
      </Radio.Group>
    </Form.Item>

    {alignUsers ? (
      alignedContent
    ) : (
      <Form.Item
        label="Run as"
        name="agor_user_id"
        rules={[{ required: true, message: 'Please select a user' }]}
        tooltip="All sessions from this channel will run as this Agor user"
      >
        <UserSelect userById={userById} />
      </Form.Item>
    )}
  </>
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
// Unified create-wizard step model
// ============================================================================

/**
 * Step-indicator items for the create wizard, keyed by channel type. Every flow
 * shares a universal step 0 ("Channel": type, name, target branch, enabled);
 * platform-specific steps follow. A single modal footer drives navigation, so
 * the indicator is the only place step structure differs between platforms.
 */
function createStepsForType(type: ChannelType): { title: string }[] {
  switch (type) {
    case 'slack':
      return [
        { title: 'Channel' },
        { title: 'Options' },
        { title: 'Create app' },
        { title: 'Tokens & test' },
      ];
    case 'github':
      return [
        { title: 'Channel' },
        { title: 'Create app' },
        { title: 'Credentials' },
        { title: 'Configure' },
      ];
    case 'teams':
      return [{ title: 'Channel' }, { title: 'Setup' }];
    default:
      return [{ title: 'Channel' }];
  }
}

/**
 * Form fields the create footer validates before leaving a given step. The final
 * step returns `[]` — submission runs a full `validateFields()` instead.
 */
function createStepFields(type: ChannelType, step: number, alignSlackUsers: boolean): string[] {
  if (step === 0) {
    const fields = ['name', 'target_branch_id', 'channel_type'];
    // Slack and GitHub pick identity inside their platform steps; everyone else
    // chooses it on the universal Channel step.
    if (type !== 'slack' && type !== 'github') fields.push('agor_user_id');
    return fields;
  }
  if (type === 'slack' && step === 1) {
    const fields = ['slack_app_name'];
    if (!alignSlackUsers) fields.push('agor_user_id');
    return fields;
  }
  if (type === 'github' && step === 2) {
    return ['github_app_id', 'github_private_key'];
  }
  return [];
}

// ============================================================================
// Slack Setup Wizard (create mode)
// ============================================================================

/**
 * Form fields whose values feed the `gateway-channels/test` probe. Editing any
 * of them makes a previously-passing test result stale, so the green result is
 * cleared when one changes.
 */
const SLACK_PROBE_FIELDS = new Set<string>([
  'bot_token',
  'app_token',
  'slack_app_name',
  'enable_channels',
  'enable_groups',
  'enable_mpim',
  'align_slack_users',
  'outbound_enabled',
  'slack_public_scope',
  'allowed_channel_ids',
]);

/**
 * Copy text to the clipboard, falling back to a transient textarea +
 * `execCommand('copy')` for browsers/contexts where the async Clipboard API is
 * unavailable (e.g. non-secure origins).
 */
async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy path below.
  }
  try {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(textarea);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Honest rendering of a Slack connection probe. A green result is advisory:
 * `notVerifiable` is surfaced as a warning so success is never read as "fully
 * verified".
 */
const SlackTestResultView: React.FC<{ result: SlackTestResult }> = ({ result }) => {
  const hasFollowups = result.failures.length > 0 || result.notVerifiable.length > 0;
  return (
    <div style={{ marginBottom: 16 }}>
      <Alert
        type={result.ok ? 'success' : 'error'}
        showIcon
        icon={result.ok ? <CheckCircleOutlined /> : <CloseCircleOutlined />}
        title={result.ok ? 'Connection succeeded' : 'Connection failed'}
        description={
          <div style={{ fontSize: 12 }}>
            {result.team && (
              <div>
                Team: <strong>{result.team.name}</strong> ({result.team.id})
              </div>
            )}
            {result.bot && (
              <div>
                Bot: <strong>{result.bot.name}</strong> ({result.bot.userId})
              </div>
            )}
            <div>
              App token (Socket Mode):{' '}
              <strong>{result.appTokenValid ? 'valid' : 'not verified'}</strong>
            </div>
            {result.channelAccess && result.channelAccess.length > 0 && (
              <div style={{ marginTop: 4 }}>
                Sampled channel access:
                <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                  {result.channelAccess.map((c) => (
                    <li key={c.channelId}>
                      <code>{c.channelId}</code>: {c.ok ? 'ok' : 'no access'}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        }
        style={{ marginBottom: hasFollowups ? 12 : 0 }}
      />
      {result.failures.length > 0 && (
        <Alert
          type="error"
          showIcon
          title="Failures"
          description={
            <ul style={{ margin: '4px 0 0', paddingLeft: 18, fontSize: 12 }}>
              {result.failures.map((f) => (
                <li key={`${f.capability}:${f.reason}`}>
                  <strong>{f.capability}</strong>: {f.reason}
                  {f.needed ? ` (needs ${f.needed})` : ''}
                </li>
              ))}
            </ul>
          }
          style={{ marginBottom: result.notVerifiable.length > 0 ? 12 : 0 }}
        />
      )}
      {result.notVerifiable.length > 0 && (
        <Alert
          type="warning"
          showIcon
          icon={<ExclamationCircleOutlined />}
          title="Not verifiable from here"
          description={
            <div style={{ fontSize: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                A green result does not guarantee these — confirm them in Slack:
              </Typography.Text>
              <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
                {result.notVerifiable.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            </div>
          }
          style={{ fontSize: 12 }}
        />
      )}
    </div>
  );
};

/**
 * Recommended Slack app manifest for an existing channel. Derived from the
 * channel's current capability toggles via {@link buildSlackManifest}, so it
 * always shows the manifest the app *should* have — not a readout of the app's
 * live Slack configuration. Paste it back into Slack to align scopes/events.
 */
const SlackManifestPanel: React.FC<{ options: SlackWizardOptions }> = ({ options }) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [copied, setCopied] = useState(false);

  const manifestJson = useMemo(
    () => JSON.stringify(buildSlackManifest(options), null, 2),
    [options]
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: manifestJson is the change trigger, not a value read in the body.
  useEffect(() => {
    setCopied(false);
  }, [manifestJson]);

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(manifestJson);
    if (ok) {
      setCopied(true);
    } else {
      showError('Copy failed — select the manifest text and copy it manually.');
    }
  };

  return (
    <>
      <Typography.Text
        type="secondary"
        style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
      >
        The recommended manifest for this channel&apos;s current options — the desired Slack app
        configuration, not a readout of your app&apos;s live settings. Paste it into{' '}
        <strong>App Manifest</strong> in your Slack app to align its scopes and events.
      </Typography.Text>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
        <Button
          size="small"
          icon={copied ? <CheckCircleOutlined /> : <CopyOutlined />}
          onClick={handleCopy}
        >
          {copied ? 'Copied' : 'Copy app manifest'}
        </Button>
      </div>
      <pre
        style={{
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorder}`,
          borderRadius: token.borderRadius,
          padding: 12,
          margin: 0,
          maxHeight: 280,
          overflow: 'auto',
          fontSize: 11,
          lineHeight: 1.5,
          fontFamily: 'monospace',
        }}
      >
        {manifestJson}
      </pre>
    </>
  );
};

/** Whether a sensitive config field is already stored (API redacts it to the sentinel). */
function isSecretStored(config: Record<string, unknown> | undefined, field: string): boolean {
  const value = config?.[field];
  return value === GATEWAY_REDACTED_SENTINEL || (typeof value === 'string' && value.length > 0);
}

/** Inline "Stored" / "Not set" badge for an edit-form secret field. */
const SecretStatusTag: React.FC<{ stored: boolean }> = ({ stored }) =>
  stored ? (
    <Tag color="green" icon={<CheckCircleOutlined />} style={{ marginInlineStart: 8 }}>
      Stored
    </Tag>
  ) : (
    <Tag style={{ marginInlineStart: 8 }}>Not set</Tag>
  );

/**
 * Guided Slack setup wizard shown on create. Step state is lifted to the parent
 * and navigation lives in the unified modal footer. Selections drive a live
 * manifest preview + derived scope/event list via {@link buildSlackManifest} /
 * {@link requiredBotScopes}, so the user never adds a scope by hand.
 */
const SlackSetupWizard: React.FC<{
  form: FormInstance;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  selectedAgent: string;
  onAgentChange: (agent: string) => void;
  /** Slack sub-step within the unified create wizard (0=Options, 1=Create app, 2=Tokens). */
  step: number;
  testResult: SlackTestResult | null;
  testLoading: boolean;
  onTest: () => void;
}> = ({
  form,
  userById,
  mcpServerById,
  selectedAgent,
  onAgentChange,
  step,
  testResult,
  testLoading,
  onTest,
}) => {
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [copied, setCopied] = useState(false);

  const appName = (Form.useWatch('slack_app_name', form) as string) ?? '';
  const enableChannels = Form.useWatch('enable_channels', form) ?? false;
  const enableGroups = Form.useWatch('enable_groups', form) ?? false;
  const enableMpim = Form.useWatch('enable_mpim', form) ?? false;
  const alignUsers = Form.useWatch('align_slack_users', form) ?? false;
  const outbound = Form.useWatch('outbound_enabled', form) ?? false;
  const publicScope = (Form.useWatch('slack_public_scope', form) as string) ?? 'all';

  const wizardOptions: SlackWizardOptions = useMemo(
    () => ({
      appName: appName || 'Agor',
      publicChannels: enableChannels,
      privateChannels: enableGroups,
      groupDms: enableMpim,
      alignUsers,
      outbound,
    }),
    [appName, enableChannels, enableGroups, enableMpim, alignUsers, outbound]
  );

  const manifestJson = useMemo(
    () => JSON.stringify(buildSlackManifest(wizardOptions), null, 2),
    [wizardOptions]
  );
  const scopes = useMemo(() => requiredBotScopes(wizardOptions), [wizardOptions]);
  const events = useMemo(() => requiredBotEvents(wizardOptions), [wizardOptions]);

  // Reset the "Copied" affordance whenever the manifest content changes.
  // (Stale test-result invalidation is owned by the parent's Form onValuesChange,
  // which fires on real edits without racing useWatch against the async probe.)
  // biome-ignore lint/correctness/useExhaustiveDependencies: manifestJson is the change trigger, not a value read in the body.
  useEffect(() => {
    setCopied(false);
  }, [manifestJson]);

  const manifestPreview = (
    <pre
      style={{
        background: token.colorBgContainer,
        border: `1px solid ${token.colorBorder}`,
        borderRadius: token.borderRadius,
        padding: 12,
        margin: '0 0 16px',
        maxHeight: 280,
        overflow: 'auto',
        fontSize: 11,
        lineHeight: 1.5,
        fontFamily: 'monospace',
      }}
    >
      {manifestJson}
    </pre>
  );

  const scopeList = (
    <div style={{ marginBottom: 16 }}>
      <Typography.Text strong style={{ fontSize: 12 }}>
        Bot scopes ({scopes.length})
      </Typography.Text>
      <div style={{ marginTop: 6 }}>
        {scopes.map((s) => (
          <Tag key={s} style={{ marginBottom: 4, fontFamily: 'monospace', fontSize: 11 }}>
            {s}
          </Tag>
        ))}
      </div>
      <Typography.Text strong style={{ fontSize: 12, display: 'block', marginTop: 8 }}>
        Event subscriptions ({events.length})
      </Typography.Text>
      <div style={{ marginTop: 6 }}>
        {events.map((e) => (
          <Tag
            key={e}
            color="blue"
            style={{ marginBottom: 4, fontFamily: 'monospace', fontSize: 11 }}
          >
            {e}
          </Tag>
        ))}
      </div>
    </div>
  );

  const handleCopy = async () => {
    const ok = await copyTextToClipboard(manifestJson);
    if (ok) {
      setCopied(true);
    } else {
      showError('Copy failed — select the manifest text and copy it manually.');
    }
  };

  const handleTestClick = async () => {
    try {
      await form.validateFields(['bot_token', 'app_token']);
    } catch {
      return;
    }
    onTest();
  };

  return (
    <>
      {/* Step 0: Options (kept mounted so Form.Items stay registered for validation) */}
      <div style={{ display: step === 0 ? undefined : 'none' }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          Choose what the bot can do. Your selections build a Slack app manifest below — paste it
          into Slack in the next step so every scope and event is preconfigured for you.
        </Typography.Paragraph>

        <Form.Item
          label="App Name"
          name="slack_app_name"
          initialValue="Agor"
          rules={[{ required: true, message: 'Enter a name for the Slack app' }]}
          tooltip="Display name for the Slack app created from the manifest"
        >
          <Input placeholder="Agor" />
        </Form.Item>

        <div style={{ marginBottom: 16 }}>
          <Typography.Text strong style={{ fontSize: 13 }}>
            Surfaces
          </Typography.Text>
          <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '4px 0 12px' }}>
            Where the bot listens for messages.
          </Typography.Paragraph>

          <div style={{ marginBottom: 8 }}>
            <Checkbox checked disabled>
              Direct messages
            </Checkbox>
            <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
              always on
            </Typography.Text>
          </div>

          <div style={{ marginBottom: 8 }}>
            <Form.Item name="enable_channels" valuePropName="checked" initialValue={false} noStyle>
              <Checkbox>Public channels</Checkbox>
            </Form.Item>
          </div>
          {enableChannels && (
            <div style={{ margin: '0 0 8px 24px' }}>
              <Form.Item name="slack_public_scope" initialValue="all" noStyle>
                <Radio.Group>
                  <Space orientation="vertical" size={4}>
                    <Radio value="all">All public channels the bot is added to</Radio>
                    <Radio value="specific">Specific channels only</Radio>
                  </Space>
                </Radio.Group>
              </Form.Item>
              {publicScope === 'specific' && (
                <Form.Item
                  name="allowed_channel_ids"
                  style={{ marginTop: 8, marginBottom: 0 }}
                  tooltip="Slack channel IDs (e.g., C01ABC123XY). Press Enter to add each ID."
                >
                  <Select
                    mode="tags"
                    placeholder="C01ABC123XY"
                    style={{ width: '100%' }}
                    tokenSeparators={[',', ' ']}
                  />
                </Form.Item>
              )}
            </div>
          )}

          <div style={{ marginBottom: 8 }}>
            <Form.Item name="enable_groups" valuePropName="checked" initialValue={false} noStyle>
              <Checkbox>Private channels</Checkbox>
            </Form.Item>
          </div>
          <div>
            <Form.Item name="enable_mpim" valuePropName="checked" initialValue={false} noStyle>
              <Checkbox>Group DMs</Checkbox>
            </Form.Item>
          </div>
        </div>

        <Form.Item
          label="Align Slack users"
          name="align_slack_users"
          valuePropName="checked"
          initialValue={false}
          tooltip="Match each Slack profile email to an Agor user. Unmatched users are rejected."
        >
          <Switch />
        </Form.Item>
        {alignUsers ? (
          <Alert
            type="info"
            showIcon
            title="Requires users:read.email scope"
            description="Added to the manifest automatically so Agor can match Slack profiles by email."
            style={{ fontSize: 12, marginBottom: 16 }}
          />
        ) : (
          <Form.Item
            label="Run as"
            name="agor_user_id"
            rules={[{ required: true, message: 'Please select a user' }]}
            tooltip="All sessions from this channel run as this Agor user"
          >
            <UserSelect userById={userById} />
          </Form.Item>
        )}

        <Form.Item
          label="Enable outbound sends"
          name="outbound_enabled"
          valuePropName="checked"
          initialValue={false}
          tooltip="Allow authorized agents to send proactive Slack messages through this gateway."
        >
          <Switch />
        </Form.Item>
        {outbound && (
          <Form.Item
            label="Default outbound target"
            name="default_outbound_target"
            tooltip="Optional. Used when the agent omits a target. Examples: #project-updates, channel:C01ABC123, user@example.com."
          >
            <Input placeholder="#project-updates, channel:C01ABC123, or user@example.com" />
          </Form.Item>
        )}

        <Typography.Text strong style={{ fontSize: 13, display: 'block', marginBottom: 8 }}>
          Manifest preview
        </Typography.Text>
        {manifestPreview}
        {scopeList}
      </div>

      {/* Step 1: Create app from manifest */}
      <div style={{ display: step === 1 ? undefined : 'none' }}>
        <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
          Create the Slack app from this manifest. Slack preconfigures every scope and event for you
          — no manual scope entry needed.
        </Typography.Paragraph>

        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
          <Button
            size="small"
            icon={copied ? <CheckCircleOutlined /> : <CopyOutlined />}
            onClick={handleCopy}
          >
            {copied ? 'Copied' : 'Copy manifest'}
          </Button>
        </div>
        {manifestPreview}

        <ol style={{ paddingLeft: 20, margin: '0 0 16px', fontSize: 13 }}>
          <li>
            Open{' '}
            <Typography.Link
              href="https://api.slack.com/apps?new_app=1"
              target="_blank"
              rel="noopener noreferrer"
            >
              api.slack.com/apps
            </Typography.Link>{' '}
            → <strong>Create New App</strong> → <strong>From a manifest</strong>.
          </li>
          <li>
            Pick your workspace, paste the manifest above, and click <strong>Create</strong>.
          </li>
          <li>
            <strong>Install</strong> the app to your workspace when prompted.
          </li>
          <li>
            Go to <strong>Basic Information → App-Level Tokens</strong> and generate a token with
            the <code>connections:write</code> scope — this is your <code>xapp-</code> token.
          </li>
        </ol>
      </div>

      {/* Step 2: Tokens + test */}
      <div style={{ display: step === 2 ? undefined : 'none' }}>
        <Alert
          type="info"
          showIcon
          title="Where to find these tokens"
          description={
            <span>
              <strong>Bot token (xoxb-)</strong>: OAuth &amp; Permissions → Bot User OAuth Token.
              <br />
              <strong>App token (xapp-)</strong>: Basic Information → App-Level Tokens.
            </span>
          }
          style={{ marginBottom: 16, fontSize: 12 }}
        />

        <Form.Item
          label="Bot Token"
          name="bot_token"
          rules={[{ required: true, message: 'Bot token is required' }]}
          tooltip="OAuth & Permissions → Bot User OAuth Token (xoxb-...)"
        >
          <Input.Password placeholder="xoxb-..." />
        </Form.Item>

        <Form.Item
          label="App Token"
          name="app_token"
          rules={[{ required: true, message: 'App token is required' }]}
          tooltip="Basic Information → App-Level Tokens (xapp-...)"
        >
          <Input.Password placeholder="xapp-..." />
        </Form.Item>

        <Button
          icon={<ThunderboltOutlined />}
          loading={testLoading}
          onClick={handleTestClick}
          style={{ marginBottom: 12 }}
        >
          Test connection
        </Button>

        {testResult && <SlackTestResultView result={testResult} />}

        {!testResult?.ok && (
          <Alert
            type="warning"
            showIcon
            title="Testing is optional"
            description="Slack can't be fully verified up front. You can save now and confirm by sending the bot a message — but an untested channel may not work."
            style={{ marginBottom: 16, fontSize: 12 }}
          />
        )}

        <Collapse
          ghost
          destroyOnHidden={false}
          style={{ marginLeft: -16, marginRight: -16 }}
          items={[
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
      </div>
    </>
  );
};

/** Shared form fields for create and edit modals */
const ChannelFormFields: React.FC<{
  form: FormInstance;
  mode: 'create' | 'edit';
  channelType: ChannelType;
  onChannelTypeChange: (type: ChannelType) => void;
  branchById: Map<string, Branch>;
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  selectedAgent: string;
  onAgentChange: (agent: string) => void;
  editingChannel?: GatewayChannel | null;
  /** Current step in the unified create wizard (0 = universal "Channel" step). */
  createStep: number;
  /** GitHub setup status (create mode only). */
  githubLoading: boolean;
  githubError: string | null;
  /** Slack guided-setup state (create mode only). */
  slackTestResult: SlackTestResult | null;
  slackTestLoading: boolean;
  onSlackTest: () => void;
}> = ({
  form,
  mode,
  channelType,
  onChannelTypeChange,
  branchById,
  userById,
  mcpServerById,
  selectedAgent,
  onAgentChange,
  editingChannel,
  createStep,
  githubLoading,
  githubError,
  slackTestResult,
  slackTestLoading,
  onSlackTest,
}) => {
  const { showError } = useThemedMessage();

  // Watch message source settings for showing warnings/scope requirements. A
  // watched value is `undefined` while its (lazily-rendered) Collapse panel is
  // still collapsed, so on edit fall back to the channel's stored config —
  // otherwise the manifest/scope sections would render as if every surface were
  // off until the user first expands Message Sources.
  const slackConfig = editingChannel?.config as Record<string, unknown> | undefined;
  const enableChannels = Boolean(
    Form.useWatch('enable_channels', form) ?? slackConfig?.enable_channels
  );
  const enableGroups = Boolean(Form.useWatch('enable_groups', form) ?? slackConfig?.enable_groups);
  const enableMpim = Boolean(Form.useWatch('enable_mpim', form) ?? slackConfig?.enable_mpim);
  const alignSlackUsers = Boolean(
    Form.useWatch('align_slack_users', form) ?? slackConfig?.align_slack_users
  );
  const outboundEnabled = Boolean(
    Form.useWatch('outbound_enabled', form) ?? slackConfig?.outbound_enabled
  );
  const alignGithubUsers = Form.useWatch('github_align_users', form) ?? false;
  // Track the live Name field so the manifest preview reflects in-progress edits,
  // falling back to the stored channel name.
  const channelName = (Form.useWatch('name', form) as string | undefined) ?? editingChannel?.name;

  const sourcesEnabled = enableChannels || enableGroups || enableMpim;

  // Derive the recommended manifest + required scopes/events from the channel's
  // live toggles so the edit form is a single source of truth that can never
  // drift from the core generator.
  const slackOptions: SlackWizardOptions = useMemo(
    () => ({
      appName: channelName || 'Agor',
      publicChannels: enableChannels,
      privateChannels: enableGroups,
      groupDms: enableMpim,
      alignUsers: alignSlackUsers,
      outbound: outboundEnabled,
    }),
    [channelName, enableChannels, enableGroups, enableMpim, alignSlackUsers, outboundEnabled]
  );
  const slackScopes = useMemo(() => requiredBotScopes(slackOptions), [slackOptions]);
  const slackEvents = useMemo(() => requiredBotEvents(slackOptions), [slackOptions]);

  const botTokenStored = isSecretStored(slackConfig, 'bot_token');
  const appTokenStored = isSecretStored(slackConfig, 'app_token');

  return (
    <>
      {/* Unified step indicator — sits directly under the modal title on create,
          fixed above the scrollable content so it never scrolls away. */}
      {mode === 'create' && (
        <Steps
          current={createStep}
          size="small"
          items={createStepsForType(channelType)}
          style={{ marginBottom: 16, flexShrink: 0 }}
        />
      )}

      {/* On create the step content scrolls inside a viewport-capped region while
          the title (antd), step indicator (above) and footer (antd) stay fixed.
          The paddingInline/marginInline pair lets edge-bleeding Collapses align to
          the body edge without producing a horizontal scrollbar. */}
      <div
        style={
          mode === 'create'
            ? {
                maxHeight: '56vh',
                overflowY: 'auto',
                overflowX: 'hidden',
                paddingInline: 16,
                marginInline: -16,
              }
            : undefined
        }
      >
        {/* ── Step 0 "Channel": universal basics. Kept mounted on create so its
            required fields stay registered for the final validateFields(). ── */}
        <div style={{ display: mode === 'create' && createStep !== 0 ? 'none' : undefined }}>
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
            label="Target Branch"
            name="target_branch_id"
            rules={[{ required: true, message: 'Please select a target branch' }]}
            tooltip={
              mode === 'create'
                ? 'New sessions from this channel will be created in this branch'
                : undefined
            }
          >
            <BranchSelect branchById={branchById} />
          </Form.Item>

          {/* Slack and GitHub choose identity in their platform-specific Identity sections. */}
          {channelType !== 'slack' && channelType !== 'github' && (
            <Form.Item
              label="Post messages as"
              name="agor_user_id"
              rules={[{ required: true, message: 'Please select a user' }]}
              tooltip="Sessions from this channel will run as this Agor user"
            >
              <UserSelect userById={userById} />
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

          {channelType !== 'slack' && channelType !== 'github' && channelType !== 'teams' && (
            <Alert
              title={`${channelType.charAt(0).toUpperCase() + channelType.slice(1)} support coming soon`}
              description="This platform integration is not yet available. Slack, GitHub, and Microsoft Teams are currently supported."
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
            />
          )}
        </div>

        {/* ── GitHub App Setup (create steps + shared config collapse) ── */}
        {channelType === 'github' && (
          <>
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
                title="GitHub Setup Error"
                description={githubError}
                style={{ marginBottom: 16 }}
              />
            )}

            {/* Step 1 (Create app): register the GitHub App. */}
            {mode === 'create' && createStep === 1 && !githubLoading && (
              <div style={{ marginBottom: 16 }}>
                <Typography.Paragraph type="secondary" style={{ fontSize: 13 }}>
                  Create a GitHub App to connect Agor to your repositories. This uses GitHub&apos;s
                  URL-parameters registration flow — you&apos;ll be redirected to GitHub with the
                  form pre-filled, then brought back here to complete setup.
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
                  onClick={async () => {
                    const daemonUrl = getDaemonUrl();
                    const params = new URLSearchParams();
                    const appName = form.getFieldValue('github_app_name');
                    const org = form.getFieldValue('github_org');
                    if (appName) params.set('name', appName);
                    if (org) params.set('org', org);

                    // Fetch a one-time CSRF state token bound to the current admin.
                    // This authenticates the install-initiation step and binds the
                    // post-install callback to this user_id.
                    try {
                      const accessToken = localStorage.getItem(ACCESS_TOKEN_KEY);
                      if (!accessToken) {
                        showError('You must be logged in as an admin to install the GitHub App.');
                        return;
                      }
                      const stateRes = await fetch(`${daemonUrl}/api/github/setup/state`, {
                        method: 'POST',
                        headers: {
                          Authorization: `Bearer ${accessToken}`,
                          'Content-Type': 'application/json',
                        },
                      });
                      if (!stateRes.ok) {
                        const body = await stateRes
                          .json()
                          .catch(() => ({}) as Record<string, unknown>);
                        const err =
                          typeof body?.error === 'string'
                            ? body.error
                            : `Failed to start GitHub App install (HTTP ${stateRes.status})`;
                        showError(err);
                        return;
                      }
                      const { state } = (await stateRes.json()) as { state?: string };
                      if (!state) {
                        showError('Daemon did not return an install state token.');
                        return;
                      }
                      params.set('state', state);
                      window.open(
                        `${daemonUrl}/api/github/setup/new?${params.toString()}`,
                        '_blank'
                      );
                    } catch (err) {
                      showError(
                        err instanceof Error ? err.message : 'Failed to initiate GitHub App install'
                      );
                    }
                  }}
                >
                  Create GitHub App on GitHub
                </Button>

                <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '12px 0 0' }}>
                  Already created the app? Click <strong>Continue</strong> below to enter its
                  credentials.
                </Typography.Paragraph>
              </div>
            )}

            {/* Step 2 (Credentials): App ID + private key. */}
            {mode === 'create' && createStep === 2 && !githubLoading && (
              <div style={{ marginBottom: 16 }}>
                <Alert
                  type="info"
                  showIcon
                  title="Enter your GitHub App credentials"
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
                  rules={[{ required: true, message: 'Enter your GitHub App ID' }]}
                  tooltip="Found on your GitHub App's settings page (General → About)"
                >
                  <Input placeholder="123456" />
                </Form.Item>

                <Form.Item
                  label="Private Key (PEM)"
                  name="github_private_key"
                  rules={[{ required: true, message: 'Paste your GitHub App private key' }]}
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
                  <Alert type="error" showIcon title={githubError} style={{ marginBottom: 12 }} />
                )}
              </div>
            )}

            {/* Step 3 (Configure): shared settings collapse — also the edit-mode body. */}
            {((mode === 'create' && createStep === 3) || mode === 'edit') && !githubLoading && (
              <Collapse
                ghost
                destroyOnHidden={false}
                defaultActiveKey={mode === 'create' ? ['identity', 'github-config'] : []}
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
                  // ── Identity ──
                  {
                    key: 'identity',
                    label: (
                      <SectionLabel
                        icon={<UserOutlined />}
                        title="Identity"
                        subtitle={getIdentitySubtitle(alignGithubUsers)}
                      />
                    ),
                    children: (
                      <PlatformIdentityFields
                        alignFieldName="github_align_users"
                        alignLabel="Align GitHub users"
                        alignDescription="Map GitHub logins to Agor users. Unmapped users are rejected."
                        alignUsers={alignGithubUsers}
                        userById={userById}
                        alignedContent={
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
                        }
                      />
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
                          Define environment variables for sessions created from this channel.
                          Useful for service account tokens or API keys for MCP servers.
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

        {/* ── Teams setup (create step 1, or the whole edit body) ── */}
        {channelType === 'teams' && (mode === 'edit' || createStep === 1) && (
          <Collapse
            ghost
            destroyOnHidden={false}
            defaultActiveKey={mode === 'create' ? ['teams-credentials'] : []}
            style={{ marginLeft: -16, marginRight: -16 }}
            items={[
              // ── Credentials ──
              {
                key: 'teams-credentials',
                label: (
                  <SectionLabel
                    icon={<KeyOutlined />}
                    title="Azure Bot Credentials"
                    subtitle={mode === 'edit' ? 'leave blank to keep current' : undefined}
                  />
                ),
                children: (
                  <>
                    <Form.Item
                      label="App ID"
                      name="teams_app_id"
                      rules={
                        mode === 'create'
                          ? [{ required: true, message: 'Azure Bot App ID is required' }]
                          : []
                      }
                      tooltip="Azure Bot Registration Application (client) ID"
                    >
                      <Input placeholder="00000000-0000-0000-0000-000000000000" />
                    </Form.Item>

                    <Form.Item
                      label="App Password"
                      name="teams_app_password"
                      rules={
                        mode === 'create'
                          ? [{ required: true, message: 'Azure Bot App Password is required' }]
                          : []
                      }
                      tooltip="Azure Bot Registration client secret (value, not the secret ID)"
                    >
                      <Input.Password
                        placeholder={mode === 'edit' ? '••••••••' : 'Client secret value'}
                      />
                    </Form.Item>

                    <Form.Item
                      label="Tenant ID"
                      name="teams_tenant_id"
                      rules={[
                        {
                          required: true,
                          message: 'Tenant ID is required for Teams bots',
                        },
                      ]}
                      tooltip="Azure AD Tenant ID. Required so the bot can acquire tokens to send replies."
                    >
                      <Input placeholder="00000000-0000-0000-0000-000000000000" />
                    </Form.Item>

                    <Alert
                      type="info"
                      showIcon
                      message="Azure Bot Setup"
                      description={
                        <span>
                          Create an Azure Bot resource in the{' '}
                          <Typography.Link
                            href="https://portal.azure.com/#create/Microsoft.AzureBotService"
                            target="_blank"
                            rel="noopener noreferrer"
                          >
                            Azure Portal
                          </Typography.Link>
                          . Both single-tenant and multi-tenant bots are supported. The{' '}
                          <strong>Tenant ID</strong> is required so the bot can send replies. Then
                          sideload the bot as a Teams app via a custom manifest.
                        </span>
                      }
                      style={{ fontSize: 12 }}
                    />
                  </>
                ),
              },

              // ── Message Sources ──
              {
                key: 'teams-message-sources',
                label: (
                  <SectionLabel
                    icon={<MessageOutlined />}
                    title="Message Sources"
                    subtitle="DMs & channels"
                  />
                ),
                children: (
                  <>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginBottom: 16 }}
                    >
                      Configure how the bot responds in Teams channels vs 1:1 chats. Direct messages
                      are always enabled.
                    </Typography.Text>

                    <Form.Item
                      label="Require @mention in channels"
                      name="teams_require_mention"
                      valuePropName="checked"
                      initialValue={true}
                      tooltip="When enabled, bot only responds when @mentioned in Teams channels (recommended)"
                    >
                      <Switch />
                    </Form.Item>
                  </>
                ),
              },

              // ── Webhook Configuration ──
              {
                key: 'teams-webhook',
                label: (
                  <SectionLabel
                    icon={<ToolOutlined />}
                    title="Webhook Configuration"
                    subtitle="port & path"
                  />
                ),
                children: (
                  <>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
                    >
                      The Teams connector runs an HTTP server for the Bot Framework messaging
                      endpoint. Configure the port and path to match your Azure Bot&apos;s messaging
                      endpoint URL.
                    </Typography.Text>

                    <Form.Item
                      label="Webhook Port"
                      name="teams_webhook_port"
                      initialValue={3978}
                      tooltip="Port for the Bot Framework HTTP endpoint"
                    >
                      <InputNumber min={1024} max={65535} style={{ width: '100%' }} />
                    </Form.Item>

                    <Form.Item
                      label="Webhook Path"
                      name="teams_webhook_path"
                      initialValue="/api/messages"
                      tooltip="URL path for the Bot Framework messaging endpoint"
                    >
                      <Input placeholder="/api/messages" />
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

        {/* ── Slack guided setup wizard (create steps 1–3) ── */}
        {channelType === 'slack' && mode === 'create' && createStep >= 1 && (
          <SlackSetupWizard
            form={form}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={onAgentChange}
            step={createStep - 1}
            testResult={slackTestResult}
            testLoading={slackTestLoading}
            onTest={onSlackTest}
          />
        )}

        {/* ── Collapsible sections (Slack edit) ── */}
        {channelType === 'slack' && mode === 'edit' && (
          <Collapse
            ghost
            destroyOnHidden={false}
            defaultActiveKey={[]}
            style={{ marginLeft: -16, marginRight: -16 }}
            items={[
              // ── Identity ──
              {
                key: 'identity',
                label: (
                  <SectionLabel
                    icon={<TeamOutlined />}
                    title="Identity"
                    subtitle={getIdentitySubtitle(alignSlackUsers)}
                  />
                ),
                children: (
                  <PlatformIdentityFields
                    alignFieldName="align_slack_users"
                    alignLabel="Align Slack users"
                    alignDescription="Match Slack profile email to an Agor user. Unmatched users are rejected."
                    alignUsers={alignSlackUsers}
                    userById={userById}
                    alignedContent={
                      <Alert
                        type="info"
                        showIcon
                        title="Requires users:read.email scope"
                        description={
                          <span>
                            Add <code>users:read.email</code> to your Slack app so Agor can match
                            Slack profiles by email.
                          </span>
                        }
                        style={{ fontSize: 12 }}
                      />
                    }
                  />
                ),
              },
              // ── Credentials ──
              {
                key: 'credentials',
                label: (
                  <SectionLabel
                    icon={<KeyOutlined />}
                    title="Credentials"
                    subtitle="blank keeps stored values"
                  />
                ),
                children: (
                  <>
                    <Form.Item
                      label={
                        <span>
                          Bot Token <SecretStatusTag stored={botTokenStored} />
                        </span>
                      }
                      name="bot_token"
                      tooltip="Slack Bot User OAuth Token (xoxb-...)"
                      extra={
                        botTokenStored
                          ? 'A token is stored. Leave blank to keep it; enter a value to overwrite it.'
                          : 'No token stored yet. Enter the bot token (xoxb-...).'
                      }
                    >
                      <Input.Password placeholder={botTokenStored ? '••••••••' : 'xoxb-...'} />
                    </Form.Item>

                    <Form.Item
                      label={
                        <span>
                          App Token <SecretStatusTag stored={appTokenStored} />
                        </span>
                      }
                      name="app_token"
                      tooltip="Slack App-Level Token for Socket Mode (xapp-...)"
                      extra={
                        appTokenStored
                          ? 'A token is stored. Leave blank to keep it; enter a value to overwrite it.'
                          : 'No token stored yet. Enter the app token (xapp-...).'
                      }
                    >
                      <Input.Password placeholder={appTokenStored ? '••••••••' : 'xapp-...'} />
                    </Form.Item>

                    <Alert
                      type="info"
                      showIcon
                      title="Socket Mode Required"
                      description="Enable Socket Mode in your Slack app settings and generate an app-level token with connections:write scope."
                      style={{ fontSize: 12, marginBottom: 12 }}
                    />

                    <Button
                      icon={<ThunderboltOutlined />}
                      loading={slackTestLoading}
                      onClick={onSlackTest}
                      style={{ marginBottom: 12 }}
                    >
                      Test connection
                    </Button>
                    <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
                      Tests the stored credentials against your Slack workspace.
                    </Typography.Text>

                    {slackTestResult && <SlackTestResultView result={slackTestResult} />}
                  </>
                ),
              },

              // ── App Manifest ──
              {
                key: 'manifest',
                label: (
                  <SectionLabel
                    icon={<SlackOutlined />}
                    title="App Manifest"
                    subtitle="recommended scopes & events"
                  />
                ),
                children: <SlackManifestPanel options={slackOptions} />,
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

                    {sourcesEnabled && (
                      <Alert
                        type="info"
                        showIcon
                        title="Slack mentions are always required"
                        description="Agor only starts or continues Slack channel threads when this bot is explicitly @mentioned. Missed thread replies are included as catch-up context on the next mention."
                        style={{ marginBottom: 12 }}
                      />
                    )}

                    <Alert
                      type="info"
                      showIcon
                      title="Required Slack Scopes & Events"
                      description={
                        <div style={{ fontSize: 12 }}>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                            Derived from the selected surfaces — channel-like surfaces trigger on{' '}
                            <code>app_mention</code>, not <code>message.*</code> channel events.
                            Copy the full manifest from the App Manifest section.
                          </Typography.Text>
                          <div style={{ marginTop: 8 }}>
                            <Typography.Text strong style={{ fontSize: 12 }}>
                              Bot scopes ({slackScopes.length})
                            </Typography.Text>
                            <div style={{ marginTop: 6 }}>
                              {slackScopes.map((s) => (
                                <Tag
                                  key={s}
                                  style={{ marginBottom: 4, fontFamily: 'monospace', fontSize: 11 }}
                                >
                                  {s}
                                </Tag>
                              ))}
                            </div>
                          </div>
                          <div style={{ marginTop: 8 }}>
                            <Typography.Text strong style={{ fontSize: 12 }}>
                              Event subscriptions ({slackEvents.length})
                            </Typography.Text>
                            <div style={{ marginTop: 6 }}>
                              {slackEvents.map((e) => (
                                <Tag
                                  key={e}
                                  color="blue"
                                  style={{ marginBottom: 4, fontFamily: 'monospace', fontSize: 11 }}
                                >
                                  {e}
                                </Tag>
                              ))}
                            </div>
                          </div>
                        </div>
                      }
                      style={{ fontSize: 12 }}
                    />
                  </>
                ),
              },

              // ── Outbound ──
              {
                key: 'outbound',
                label: (
                  <SectionLabel
                    icon={<MessageOutlined />}
                    title="Outbound"
                    subtitle="proactive sends"
                  />
                ),
                children: (
                  <>
                    <Typography.Text
                      type="secondary"
                      style={{ fontSize: 12, display: 'block', marginBottom: 12 }}
                    >
                      Allow authorized agents to send proactive Slack messages through this gateway.
                      Targets can be Slack channel IDs, channel names, or Slack user emails.
                    </Typography.Text>

                    <Form.Item
                      label="Enable outbound sends"
                      name="outbound_enabled"
                      valuePropName="checked"
                      initialValue={false}
                      tooltip="When enabled, branch admins/owners with full branch access can send proactive Slack messages through this gateway."
                    >
                      <Switch />
                    </Form.Item>

                    <Form.Item
                      label="Default outbound target"
                      name="default_outbound_target"
                      tooltip="Optional. Used when the agent omits a target. Examples: #project-updates, channel:C01ABC123, user@example.com."
                    >
                      <Input placeholder="#project-updates, channel:C01ABC123, or user@example.com" />
                    </Form.Item>

                    <Alert
                      type="info"
                      showIcon
                      title="Slack scopes"
                      description={
                        <span>
                          Channel-name targets require <code>channels:read</code> and, for private
                          channels, <code>groups:read</code>. Email targets require{' '}
                          <code>users:read.email</code> and open a DM with that Slack user.
                        </span>
                      }
                      style={{ fontSize: 12 }}
                    />
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
      </div>
    </>
  );
};

export const GatewayChannelsTable: React.FC<GatewayChannelsTableProps> = ({
  client,
  gatewayChannelById,
  branchById,
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
  const [searchTerm, setSearchTerm] = useState('');
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const [referencedBranchesById, setReferencedBranchesById] = useState<Map<string, Branch>>(
    () => new Map()
  );
  const loadingReferencedBranchIds = useRef<Set<string>>(new Set());
  const referencedBranchesByIdRef = useRef<Map<string, Branch>>(new Map());

  // ── Unified create-wizard step (0 = universal "Channel" step) ──
  const [createStep, setCreateStep] = useState(0);
  const [creating, setCreating] = useState(false);

  // ── GitHub App Setup State (create mode) ──
  const [githubLoading, setGithubLoading] = useState(false);
  const [githubError, setGithubError] = useState<string | null>(null);

  // ── Slack guided-setup state (create mode) ──
  const [slackTestLoading, setSlackTestLoading] = useState(false);
  const [slackTestResult, setSlackTestResult] = useState<SlackTestResult | null>(null);

  // Keep referenced target branches resolvable in CRUD even when archived branches
  // are excluded from the core store.
  useEffect(() => {
    referencedBranchesByIdRef.current = referencedBranchesById;
  }, [referencedBranchesById]);

  useEffect(() => {
    if (!client) return;

    const targetIds = new Set<string>();
    for (const channel of gatewayChannelById.values()) {
      if (channel.target_branch_id) {
        targetIds.add(channel.target_branch_id);
      }
    }

    const missingIds = Array.from(targetIds).filter(
      (id) => !branchById.has(id) && !referencedBranchesByIdRef.current.has(id)
    );
    if (missingIds.length === 0) return;

    let cancelled = false;
    void Promise.all(
      missingIds.map(async (id) => {
        if (loadingReferencedBranchIds.current.has(id)) return null;
        loadingReferencedBranchIds.current.add(id);
        try {
          const branch = (await client.service('branches').get(id)) as Branch;
          return branch;
        } catch {
          return null;
        } finally {
          loadingReferencedBranchIds.current.delete(id);
        }
      })
    ).then((results) => {
      if (cancelled) return;
      const resolved = results.filter((wt): wt is Branch => wt !== null);
      if (resolved.length === 0) return;

      setReferencedBranchesById((prev) => {
        const next = new Map(prev);
        for (const wt of resolved) {
          next.set(wt.branch_id, wt);
        }
        return next;
      });
    });

    return () => {
      cancelled = true;
    };
  }, [client, gatewayChannelById, branchById]);

  const branchOptionsById = useMemo(() => {
    const merged = new Map<string, Branch>();
    for (const wt of branchById.values()) {
      merged.set(wt.branch_id, wt);
    }
    for (const wt of referencedBranchesById.values()) {
      if (!merged.has(wt.branch_id)) {
        merged.set(wt.branch_id, wt);
      }
    }
    return merged;
  }, [referencedBranchesById, branchById]);

  // No automatic credential fetch — user provides App ID and PEM manually

  const resetGithubState = useCallback(() => {
    setGithubLoading(false);
    setGithubError(null);
  }, []);

  const resetSlackState = useCallback(() => {
    setSlackTestLoading(false);
    setSlackTestResult(null);
  }, []);

  // Reset the whole create flow back to its universal first step.
  const resetCreateFlow = useCallback(() => {
    setCreateStep(0);
    resetGithubState();
    resetSlackState();
  }, [resetGithubState, resetSlackState]);

  const invalidateSlackTest = useCallback(() => {
    setSlackTestResult(null);
  }, []);

  // Clear a passing Slack test result the moment any probe-affecting field is
  // edited. Driven by the Form's onValuesChange (real edits only) rather than a
  // useWatch effect, so it never races the async probe that sets the result.
  const handleCreateValuesChange = useCallback(
    (changed: Record<string, unknown>) => {
      if (Object.keys(changed).some((field) => SLACK_PROBE_FIELDS.has(field))) {
        invalidateSlackTest();
      }
    },
    [invalidateSlackTest]
  );

  // Switching channel type changes the step structure, so snap back to the
  // universal first step and clear any in-progress platform setup.
  const handleChannelTypeChange = useCallback(
    (type: ChannelType) => {
      setChannelType(type);
      resetCreateFlow();
    },
    [resetCreateFlow]
  );

  // Probe the entered Slack tokens against the live workspace via the
  // `gateway-channels/test` service. No gatewayChannelId — the channel doesn't
  // exist yet, so the probe runs purely against the supplied config.
  const handleSlackTest = useCallback(async () => {
    if (!client) {
      showError('Not connected to server');
      return;
    }
    const values = createForm.getFieldsValue(true);
    const config: Record<string, unknown> = {
      bot_token: values.bot_token,
      app_token: values.app_token,
      enable_channels: values.enable_channels ?? false,
      enable_groups: values.enable_groups ?? false,
      enable_mpim: values.enable_mpim ?? false,
      align_slack_users: values.align_slack_users ?? false,
      allowed_channel_ids: values.allowed_channel_ids ?? [],
      outbound_enabled: values.outbound_enabled ?? false,
    };
    setSlackTestLoading(true);
    setSlackTestResult(null);
    try {
      const result = (await client
        .service('gateway-channels/test')
        .create({ config })) as SlackTestResult;
      setSlackTestResult(result);
    } catch (error) {
      setSlackTestResult({
        ok: false,
        failures: [
          {
            capability: 'connection',
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        notVerifiable: [],
      });
    } finally {
      setSlackTestLoading(false);
    }
  }, [client, createForm, showError]);

  // Probe an existing Slack channel via the `gateway-channels/test` service. The
  // backend resolves the stored decrypted tokens from `gatewayChannelId`, so the
  // edit form never sends credentials.
  const handleSlackEditTest = useCallback(async () => {
    if (!client) {
      showError('Not connected to server');
      return;
    }
    if (!editingChannel) return;
    setSlackTestLoading(true);
    setSlackTestResult(null);
    try {
      const result = (await client
        .service('gateway-channels/test')
        .create({ gatewayChannelId: editingChannel.id })) as SlackTestResult;
      setSlackTestResult(result);
    } catch (error) {
      setSlackTestResult({
        ok: false,
        failures: [
          {
            capability: 'connection',
            reason: error instanceof Error ? error.message : String(error),
          },
        ],
        notVerifiable: [],
      });
    } finally {
      setSlackTestLoading(false);
    }
  }, [client, editingChannel, showError]);

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
    const SENSITIVE_FIELDS = [
      'bot_token',
      'app_token',
      'signing_secret',
      'private_key',
      'app_password',
    ];
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
    } else if (values.channel_type === 'teams') {
      if (values.teams_app_id) config.app_id = values.teams_app_id;
      if (values.teams_app_password) config.app_password = values.teams_app_password;
      config.tenant_id = values.teams_tenant_id;
      config.webhook_port = (values.teams_webhook_port as number) ?? 3978;
      config.webhook_path = (values.teams_webhook_path as string) || '/api/messages';
      config.require_mention = values.teams_require_mention ?? true;
    } else if (values.channel_type === 'slack') {
      if (values.bot_token) config.bot_token = values.bot_token;
      if (values.app_token) config.app_token = values.app_token;
      if (values.connection_mode) config.connection_mode = values.connection_mode;

      // Form has preserve={true}, so all values are available even from collapsed panels.
      config.enable_channels = values.enable_channels ?? false;
      config.enable_groups = values.enable_groups ?? false;
      config.enable_mpim = values.enable_mpim ?? false;
      config.require_mention = true;
      config.align_slack_users = values.align_slack_users ?? false;
      config.allowed_channel_ids = values.allowed_channel_ids ?? [];
      config.outbound_enabled = values.outbound_enabled ?? false;
      config.default_outbound_target = values.default_outbound_target || null;
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

    // Existing aligned channels may still carry a preserved agor_user_id from a
    // previous run-as configuration, but newly-created aligned channels can omit it.
    // The gateway only reads agor_user_id when alignment is OFF.
    return {
      name: values.name as string,
      channel_type: values.channel_type as ChannelType,
      target_branch_id: values.target_branch_id as UUID,
      agor_user_id: values.agor_user_id as UUID,
      config,
      agentic_config: agenticConfig,
      enabled: (values.enabled as boolean) ?? true,
    };
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      await createForm.validateFields();
      // Use getFieldsValue(true) to include values from collapsed (unmounted)
      // panels that validateFields() may omit.
      const values = createForm.getFieldsValue(true);
      // The whitelist only applies when the wizard limits public channels to a
      // specific set; "all public channels" (or no public channels) must clear it.
      if (
        values.channel_type === 'slack' &&
        (values.slack_public_scope !== 'specific' || !values.enable_channels)
      ) {
        values.allowed_channel_ids = [];
      }
      const data = extractFormData(values, undefined, selectedAgent);

      if (!client) {
        showError('Not connected to server');
        return;
      }

      await client.service('gateway-channels').create(data);
      showSuccess('Gateway channel created!');
      createForm.resetFields();
      setCreateModalOpen(false);
      setChannelType('slack');
      resetCreateFlow();
    } catch (error: unknown) {
      const err = error as { errorFields?: { errors: string[] }[]; message?: string };
      if (err.errorFields?.length) {
        showError(err.errorFields[0].errors[0] || 'Please fill in required fields');
      } else {
        showError(`Failed to create channel: ${err.message || String(error)}`);
      }
    } finally {
      setCreating(false);
    }
  };

  // Single create-footer primary action: validate the current step, then either
  // advance or (on the final step) submit. Navigation lives only in the footer.
  const createSteps = createStepsForType(channelType);
  const isFinalCreateStep = createStep >= createSteps.length - 1;

  const handleCreatePrimary = async () => {
    if (isFinalCreateStep) {
      await handleCreate();
      return;
    }
    const fields = createStepFields(
      channelType,
      createStep,
      createForm.getFieldValue('align_slack_users') ?? false
    );
    if (fields.length > 0) {
      try {
        await createForm.validateFields(fields);
      } catch {
        return;
      }
    }
    setCreateStep((step) => step + 1);
  };

  const closeCreateModal = () => {
    createForm.resetFields();
    setCreateModalOpen(false);
    setChannelType('slack');
    setSelectedAgent('claude-code');
    resetCreateFlow();
  };

  const handleEdit = (channel: GatewayChannel) => {
    setEditingChannel(channel);
    setChannelType(channel.channel_type);
    const agent = channel.agentic_config?.agent || 'claude-code';
    setSelectedAgent(agent);
    resetSlackState();
    editForm.resetFields();

    const config = channel.config as Record<string, unknown>;

    const formValues: Record<string, unknown> = {
      name: channel.name,
      channel_type: channel.channel_type,
      target_branch_id: channel.target_branch_id,
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
      formValues.require_mention = true;
      formValues.align_slack_users = config?.align_slack_users ?? false;
      formValues.allowed_channel_ids = (config?.allowed_channel_ids as string[]) ?? [];
      formValues.outbound_enabled = config?.outbound_enabled ?? false;
      formValues.default_outbound_target = config?.default_outbound_target;
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
    } else if (channel.channel_type === 'teams') {
      formValues.teams_app_id = config?.app_id;
      formValues.teams_tenant_id = config?.tenant_id;
      formValues.teams_webhook_port = (config?.webhook_port as number) ?? 3978;
      formValues.teams_webhook_path = (config?.webhook_path as string) || '/api/messages';
      formValues.teams_require_mention = config?.require_mention ?? true;
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
      render: (name: string) => <HighlightMatch text={name} query={searchTerm} />,
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
      title: 'Target Branch',
      dataIndex: 'target_branch_id',
      key: 'target_branch_id',
      width: 180,
      render: (branchId: string) => {
        const wt = branchOptionsById.get(branchId);
        return (
          <Typography.Text type="secondary">
            <HighlightMatch
              text={
                wt
                  ? `${wt.name || wt.ref || branchId}${wt.archived ? ' (archived)' : ''}`
                  : branchId
              }
              query={searchTerm}
            />
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
      width: 96,
      render: (_: unknown, channel: GatewayChannel) => (
        <SettingsActionGroup>
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
        </SettingsActionGroup>
      ),
    },
  ];

  const channels = useMemo(() => {
    const sorted = mapToSortedArray(gatewayChannelById, (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    return filterBySettingsSearch(sorted, searchTerm, [
      (channel) => channel.name,
      (channel) => channel.channel_type,
      (channel) => channel.channel_key,
      (channel) => (channel.enabled ? 'enabled' : 'disabled'),
      (channel) => channel.last_message_at,
      (channel) => {
        const branch = branchOptionsById.get(channel.target_branch_id);
        return [branch?.name, branch?.ref, channel.target_branch_id];
      },
      (channel) => JSON.stringify(channel.config ?? {}),
    ]);
  }, [gatewayChannelById, searchTerm, branchOptionsById]);

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
          Route messages from Slack, GitHub, Microsoft Teams, and other platforms to Agor sessions.
        </Typography.Text>
        <Space>
          <Input
            allowClear
            placeholder="Search name, type, target branch, key, or config"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 360 }}
          />
          <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
            Add Channel
          </Button>
        </Space>
      </div>

      <Alert
        type="warning"
        showIcon
        style={{ marginBottom: 16 }}
        title="Beta Feature — Security Notice"
        description={
          <>
            The Message Gateway is a <strong>beta feature</strong>. Connecting external messaging
            platforms grants anyone who can message your bot potential access to Agor sessions and
            the underlying branch environment.{' '}
            <Typography.Link
              href="https://agor.live/guide/message-gateway"
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
            Add a channel to route messages from Slack, Teams, or other platforms to Agor sessions.
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
        onCancel={closeCreateModal}
        width={600}
        footer={
          // One structurally-identical footer on every step: Back (left),
          // Cancel + primary (right). Buttons never move between steps.
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <Button
              type="link"
              disabled={createStep === 0}
              onClick={() => setCreateStep((step) => Math.max(0, step - 1))}
              style={{ paddingLeft: 0 }}
            >
              Back
            </Button>
            <Space style={{ marginLeft: 'auto' }}>
              <Button onClick={closeCreateModal}>Cancel</Button>
              <Button type="primary" loading={creating} onClick={handleCreatePrimary}>
                {isFinalCreateStep ? 'Create channel' : 'Continue'}
              </Button>
            </Space>
          </div>
        }
      >
        <Form
          form={createForm}
          layout="vertical"
          preserve
          onValuesChange={handleCreateValuesChange}
          style={{ marginTop: 16 }}
        >
          <ChannelFormFields
            form={createForm}
            mode="create"
            channelType={channelType}
            onChannelTypeChange={handleChannelTypeChange}
            branchById={branchOptionsById}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
            createStep={createStep}
            githubLoading={githubLoading}
            githubError={githubError}
            slackTestResult={slackTestResult}
            slackTestLoading={slackTestLoading}
            onSlackTest={handleSlackTest}
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
          resetSlackState();
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
            branchById={branchOptionsById}
            userById={userById}
            mcpServerById={mcpServerById}
            selectedAgent={selectedAgent}
            onAgentChange={setSelectedAgent}
            editingChannel={editingChannel}
            createStep={0}
            githubLoading={false}
            githubError={null}
            slackTestResult={slackTestResult}
            slackTestLoading={slackTestLoading}
            onSlackTest={handleSlackEditTest}
          />
        </Form>
      </Modal>
    </div>
  );
};
