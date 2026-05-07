import type {
  AgenticToolName,
  AgorClient,
  EnvVarMetadata,
  EnvVarScope,
  MCPServer,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import {
  ApiOutlined,
  CloseOutlined,
  RobotOutlined,
  SettingOutlined,
  SoundOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Alert,
  Button,
  Checkbox,
  Flex,
  Form,
  Input,
  Layout,
  Menu,
  Modal,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_AUDIO_PREFERENCES } from '../../utils/audio';
import {
  AgenticToolConfigForm,
  buildConfigFromFormValues,
  getClearedFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm';
import { ApiKeyFields, type FieldStatus, TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { EnvVarEditor } from '../EnvVarEditor';
import { AudioSettingsTab } from './AudioSettingsTab';
import { PersonalApiKeysTab } from './PersonalApiKeysTab';

const { Sider, Content } = Layout;

export interface UserSettingsModalProps {
  open: boolean;
  onClose: () => void;
  user: User | null;
  mcpServerById: Map<string, MCPServer>;
  client: AgorClient | null;
  currentUser?: User | null;
  onUpdate?: (userId: string, updates: UpdateUserInput) => void;
}

export const UserSettingsModal: React.FC<UserSettingsModalProps> = ({
  open,
  onClose,
  user,
  mcpServerById,
  client,
  currentUser,
  onUpdate,
}) => {
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState<string>('general');

  // Separate forms for each agentic tool tab
  const [claudeForm] = Form.useForm();
  const [codexForm] = Form.useForm();
  const [geminiForm] = Form.useForm();
  const [opencodeForm] = Form.useForm();
  const [copilotForm] = Form.useForm();
  const [audioForm] = Form.useForm();

  // Per-tool credential presence state, keyed `${tool}.${field}` for spinner
  // tracking. The actual presence map is rebuilt from `user.agentic_tools`
  // each time the modal opens.
  const [agenticToolStatus, setAgenticToolStatus] = useState<Record<AgenticToolName, FieldStatus>>({
    'claude-code': {},
    codex: {},
    gemini: {},
    opencode: {},
    copilot: {},
  });
  const [savingToolField, setSavingToolField] = useState<Record<string, boolean>>({});

  // Environment variable management state (scope-aware, v0.5 env-var-access)
  const [userEnvVars, setUserEnvVars] = useState<Record<string, EnvVarMetadata>>({});
  const [savingEnvVars, setSavingEnvVars] = useState<Record<string, boolean>>({});

  // Saving state for agentic tool tabs
  const [savingAgenticConfig, setSavingAgenticConfig] = useState<Record<AgenticToolName, boolean>>({
    'claude-code': false,
    codex: false,
    gemini: false,
    opencode: false,
    copilot: false,
  });

  // Initialize forms when user changes or modal opens
  const initializeForms = useCallback(
    (userData: User) => {
      setActiveTab('general');

      form.setFieldsValue({
        email: userData.email,
        name: userData.name,
        emoji: userData.emoji,
        role: userData.role,
        unix_username: userData.unix_username,
        eventStreamEnabled: userData.preferences?.eventStream?.enabled ?? true,
        must_change_password: userData.must_change_password ?? false,
      });

      // Initialize agentic tool forms with user's defaults
      const defaults = userData.default_agentic_config;
      claudeForm.setFieldsValue(getFormValuesFromConfig('claude-code', defaults?.['claude-code']));
      codexForm.setFieldsValue(getFormValuesFromConfig('codex', defaults?.codex));
      geminiForm.setFieldsValue(getFormValuesFromConfig('gemini', defaults?.gemini));

      // Initialize audio form with user's preferences
      const audioPrefs = userData.preferences?.audio;
      audioForm.setFieldsValue({
        enabled: audioPrefs?.enabled ?? DEFAULT_AUDIO_PREFERENCES.enabled,
        chime: audioPrefs?.chime ?? DEFAULT_AUDIO_PREFERENCES.chime,
        volume: audioPrefs?.volume ?? DEFAULT_AUDIO_PREFERENCES.volume,
        minDurationSeconds:
          audioPrefs?.minDurationSeconds ?? DEFAULT_AUDIO_PREFERENCES.minDurationSeconds,
      });
    },
    [form, claudeForm, codexForm, geminiForm, audioForm]
  );

  // Initialize when modal opens with user data
  useEffect(() => {
    if (open && user) {
      initializeForms(user);
    }
  }, [open, user, initializeForms]);

  // Rehydrate per-tool credential presence and env-var metadata from the
  // server every time the modal opens, so flags reflect the latest patch.
  useEffect(() => {
    if (!open) return;

    const next: Record<AgenticToolName, FieldStatus> = {
      'claude-code': {},
      codex: {},
      gemini: {},
      opencode: {},
      copilot: {},
    };
    const stored = user?.agentic_tools;
    if (stored) {
      for (const tool of Object.keys(next) as AgenticToolName[]) {
        const flags = (stored as Record<string, Record<string, boolean> | undefined>)[tool];
        if (flags) {
          next[tool] = { ...flags };
        }
      }
    }
    setAgenticToolStatus(next);

    if (user?.env_vars) {
      setUserEnvVars(user.env_vars);
    } else {
      setUserEnvVars({});
    }
  }, [open, user]);

  const handleClose = () => {
    form.resetFields();
    audioForm.resetFields();
    claudeForm.resetFields();
    codexForm.resetFields();
    geminiForm.resetFields();
    setActiveTab('general');
    onClose();
  };

  const handleUpdate = () => {
    if (!user) return;

    form
      .validateFields(['email', 'name', 'emoji', 'role', 'unix_username'])
      .then(() => {
        const values = form.getFieldsValue();
        const updates: UpdateUserInput = {
          email: values.email,
          name: values.name,
          emoji: values.emoji,
          role: values.role,
          unix_username: values.unix_username,
          preferences: {
            ...user.preferences,
            eventStream: {
              enabled: values.eventStreamEnabled ?? true,
            },
          },
        };
        if (values.password?.trim()) {
          updates.password = values.password;
        }
        // Only admins can set must_change_password, and only for other users
        if (
          hasMinimumRole(currentUser?.role, ROLES.ADMIN) &&
          user.user_id !== currentUser?.user_id
        ) {
          updates.must_change_password = values.must_change_password;
        }
        onUpdate?.(user.user_id, updates);
        handleClose();
      })
      .catch((err) => {
        console.error('Validation failed:', err);
      });
  };

  // Persist a per-tool credential field. Patch is shaped as
  // `{ agentic_tools: { [tool]: { [field]: value | null } } }` — the daemon
  // service merges only the touched fields and encrypts at rest.
  const handleToolFieldSave = async (
    tool: AgenticToolName,
    field: string,
    value: string
  ): Promise<void> => {
    if (!user) return;
    const spinnerKey = `${tool}.${field}`;

    try {
      setSavingToolField((prev) => ({ ...prev, [spinnerKey]: true }));
      await onUpdate?.(user.user_id, {
        agentic_tools: {
          [tool]: { [field]: value },
        } as UpdateUserInput['agentic_tools'],
      });
      setAgenticToolStatus((prev) => ({
        ...prev,
        [tool]: { ...(prev[tool] ?? {}), [field]: true },
      }));
    } catch (err) {
      console.error(`Failed to save ${tool}.${field}:`, err);
      throw err;
    } finally {
      setSavingToolField((prev) => ({ ...prev, [spinnerKey]: false }));
    }
  };

  // Clear a per-tool credential field by sending `null` in the patch.
  const handleToolFieldClear = async (tool: AgenticToolName, field: string): Promise<void> => {
    if (!user) return;
    const spinnerKey = `${tool}.${field}`;

    try {
      setSavingToolField((prev) => ({ ...prev, [spinnerKey]: true }));
      await onUpdate?.(user.user_id, {
        agentic_tools: {
          [tool]: { [field]: null },
        } as UpdateUserInput['agentic_tools'],
      });
      setAgenticToolStatus((prev) => {
        const nextToolFields = { ...(prev[tool] ?? {}) };
        delete nextToolFields[field];
        return { ...prev, [tool]: nextToolFields };
      });
    } catch (err) {
      console.error(`Failed to clear ${tool}.${field}:`, err);
      throw err;
    } finally {
      setSavingToolField((prev) => ({ ...prev, [spinnerKey]: false }));
    }
  };

  // Handle env var save (value + scope). v0.5 env-var-access.
  const handleEnvVarSave = async (key: string, value: string, scope: EnvVarScope) => {
    if (!user) return;

    try {
      setSavingEnvVars((prev) => ({ ...prev, [key]: true }));
      await onUpdate?.(user.user_id, {
        env_vars: { [key]: value },
        env_var_scopes: { [key]: scope },
      });
      setUserEnvVars((prev) => ({
        ...prev,
        [key]: { set: true, scope, resource_id: null },
      }));
    } catch (err) {
      console.error(`Failed to save ${key}:`, err);
      throw err;
    } finally {
      setSavingEnvVars((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Handle scope change for an existing env var (no value rotation).
  const handleEnvVarScopeChange = async (key: string, scope: EnvVarScope) => {
    if (!user) return;
    try {
      setSavingEnvVars((prev) => ({ ...prev, [key]: true }));
      await onUpdate?.(user.user_id, {
        env_var_scopes: { [key]: scope },
      });
      setUserEnvVars((prev) => ({
        ...prev,
        [key]: { ...(prev[key] ?? { set: true }), set: true, scope, resource_id: null },
      }));
    } catch (err) {
      console.error(`Failed to update scope for ${key}:`, err);
      throw err;
    } finally {
      setSavingEnvVars((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Handle env var delete
  const handleEnvVarDelete = async (key: string) => {
    if (!user) return;

    try {
      setSavingEnvVars((prev) => ({ ...prev, [key]: true }));
      await onUpdate?.(user.user_id, {
        env_vars: { [key]: null },
      });
      setUserEnvVars((prev) => {
        const updated = { ...prev };
        delete updated[key];
        return updated;
      });
    } catch (err) {
      console.error(`Failed to delete ${key}:`, err);
      throw err;
    } finally {
      setSavingEnvVars((prev) => ({ ...prev, [key]: false }));
    }
  };

  // Handle agentic tool config save
  const handleAgenticConfigSave = async (tool: AgenticToolName) => {
    if (!user) return;

    const formMap = {
      'claude-code': claudeForm,
      codex: codexForm,
      gemini: geminiForm,
      opencode: opencodeForm,
      copilot: copilotForm,
    };

    try {
      setSavingAgenticConfig((prev) => ({ ...prev, [tool]: true }));

      const values = formMap[tool].getFieldsValue();
      const newConfig = {
        ...user.default_agentic_config,
        [tool]: buildConfigFromFormValues(tool, values),
      };

      await onUpdate?.(user.user_id, {
        default_agentic_config: newConfig,
      });

      handleClose();
    } catch (err) {
      console.error(`Failed to save ${tool} config:`, err);
      throw err;
    } finally {
      setSavingAgenticConfig((prev) => ({ ...prev, [tool]: false }));
    }
  };

  // Handle agentic tool config clear
  const handleAgenticConfigClear = (tool: AgenticToolName) => {
    const formMap = {
      'claude-code': claudeForm,
      codex: codexForm,
      gemini: geminiForm,
      opencode: opencodeForm,
      copilot: copilotForm,
    };

    formMap[tool].setFieldsValue(getClearedFormValues(tool));
  };

  const handleAudioSave = async () => {
    if (!user || !onUpdate) return;

    try {
      const values = audioForm.getFieldsValue();
      const updatedPreferences = {
        ...user.preferences,
        audio: {
          enabled: values.enabled,
          chime: values.chime,
          volume: values.volume,
          minDurationSeconds: values.minDurationSeconds,
        },
      };

      onUpdate(user.user_id, {
        preferences: updatedPreferences,
      });

      handleClose();
    } catch (error) {
      console.error('Failed to save audio settings:', error);
    }
  };

  // Unified save handler that routes based on active tab
  const handleModalSave = async () => {
    if (!user) return;

    switch (activeTab) {
      case 'general':
        handleUpdate();
        break;
      case 'env-vars':
      case 'personal-api-keys':
        // These tabs save individually, just close
        handleClose();
        break;
      case 'audio':
        await handleAudioSave();
        break;
      case 'claude-code':
      case 'codex':
      case 'gemini':
      case 'opencode':
      case 'copilot':
        await handleAgenticConfigSave(activeTab as AgenticToolName);
        break;
    }
  };

  const { token } = theme.useToken();

  // Menu items for left sidebar navigation
  const menuItems: MenuProps['items'] = [
    {
      key: 'profile',
      label: 'Profile',
      type: 'group',
      children: [
        {
          key: 'general',
          label: 'General',
          icon: <SettingOutlined />,
        },
        {
          key: 'env-vars',
          label: 'Env Vars',
          icon: <ThunderboltOutlined />,
        },
        {
          key: 'audio',
          label: 'Audio',
          icon: <SoundOutlined />,
        },
        {
          key: 'personal-api-keys',
          label: 'Agor API Tokens',
          icon: <ApiOutlined />,
        },
      ],
    },
    {
      key: 'agentic-tools',
      label: 'Agentic Tools',
      type: 'group',
      children: [
        {
          key: 'claude-code',
          label: 'Claude Code',
          icon: <RobotOutlined />,
        },
        {
          key: 'codex',
          label: 'Codex',
          icon: <RobotOutlined />,
        },
        {
          key: 'gemini',
          label: 'Gemini',
          icon: <RobotOutlined />,
        },
        {
          key: 'opencode',
          label: 'OpenCode',
          icon: <RobotOutlined />,
        },
        {
          key: 'copilot',
          label: 'GitHub Copilot',
          icon: <RobotOutlined />,
        },
      ],
    },
  ];

  // Render content based on active section
  const renderContent = () => {
    switch (activeTab) {
      case 'general':
        return (
          <Form form={form} layout="vertical">
            <Form.Item label="Name" style={{ marginBottom: 24 }}>
              <Flex gap={8}>
                <Form.Item name="emoji" noStyle>
                  <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="👤" />
                </Form.Item>
                <Form.Item name="name" noStyle style={{ flex: 1 }}>
                  <Input placeholder="John Doe" style={{ flex: 1 }} />
                </Form.Item>
              </Flex>
            </Form.Item>

            <Form.Item
              label="Email"
              name="email"
              rules={[
                { required: true, message: 'Please enter an email' },
                { type: 'email', message: 'Please enter a valid email' },
              ]}
            >
              <Input placeholder="user@example.com" />
            </Form.Item>

            <Form.Item
              label="Unix Username"
              name="unix_username"
              help={
                hasMinimumRole(currentUser?.role, ROLES.ADMIN)
                  ? 'Unix user for process impersonation (alphanumeric, hyphens, underscores only)'
                  : 'Maintained by administrators'
              }
              rules={[
                {
                  pattern: /^[a-z0-9_-]+$/,
                  message: 'Only lowercase letters, numbers, hyphens, and underscores allowed',
                },
                { max: 32, message: 'Unix username must be 32 characters or less' },
              ]}
            >
              <Input
                placeholder="johnsmith"
                maxLength={32}
                disabled={!hasMinimumRole(currentUser?.role, ROLES.ADMIN)}
              />
            </Form.Item>

            <Form.Item label="Password" name="password" help="Leave blank to keep current password">
              <Input.Password placeholder="••••••••" />
            </Form.Item>

            <Form.Item
              label={
                <Space size={4}>
                  Enable Live Event Stream
                  <Tag color={token.colorPrimary} style={{ fontSize: 10, marginLeft: 4 }}>
                    BETA
                  </Tag>
                </Space>
              }
              name="eventStreamEnabled"
              valuePropName="checked"
              tooltip="Show/hide the event stream icon in the navbar. When enabled, you can view live WebSocket events for debugging."
            >
              <Switch />
            </Form.Item>

            <Form.Item
              label="Role"
              name="role"
              rules={[{ required: true, message: 'Please select a role' }]}
              help={
                !hasMinimumRole(currentUser?.role, ROLES.ADMIN)
                  ? 'Maintained by administrators'
                  : undefined
              }
            >
              <Select disabled={!hasMinimumRole(currentUser?.role, ROLES.ADMIN)}>
                {/* <Select.Option value="owner">Owner</Select.Option> */}
                <Select.Option value="admin">Admin</Select.Option>
                <Select.Option value="member">Member</Select.Option>
                <Select.Option value="viewer">Viewer</Select.Option>
              </Select>
            </Form.Item>

            {/* Only show for admins editing other users */}
            {hasMinimumRole(currentUser?.role, ROLES.ADMIN) &&
              user &&
              user.user_id !== currentUser?.user_id && (
                <Form.Item name="must_change_password" valuePropName="checked">
                  <Checkbox>Force password change on next login</Checkbox>
                </Form.Item>
              )}
          </Form>
        );
      case 'env-vars':
        return (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Environment variables are encrypted at rest and available to all sessions for this
              user.
            </Typography.Paragraph>
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 16 }}
              title="Looking for SDK credentials?"
              description={
                <span>
                  API keys and SDK config (Anthropic, OpenAI, Gemini, Copilot) live under each
                  tool's screen in the <strong>Agentic Tools</strong> section. Per-tool config takes
                  precedence over global env vars and is scoped so credentials never leak across
                  SDKs.
                </span>
              }
            />
            <EnvVarEditor
              envVars={userEnvVars}
              onSave={handleEnvVarSave}
              onScopeChange={handleEnvVarScopeChange}
              onDelete={handleEnvVarDelete}
              loading={savingEnvVars}
            />
          </>
        );
      case 'audio':
        return <AudioSettingsTab user={user} form={audioForm} />;
      case 'personal-api-keys':
        return <PersonalApiKeysTab client={client} />;
      case 'claude-code':
      case 'codex':
      case 'gemini':
      case 'opencode':
      case 'copilot': {
        const toolName = activeTab as AgenticToolName;
        const formMap = {
          'claude-code': claudeForm,
          codex: codexForm,
          gemini: geminiForm,
          opencode: opencodeForm,
          copilot: copilotForm,
        };
        const currentForm = formMap[toolName];
        const displayNames: Record<AgenticToolName, string> = {
          'claude-code': 'Claude Code',
          codex: 'Codex',
          gemini: 'Gemini',
          opencode: 'OpenCode',
          copilot: 'Copilot',
        };
        // Field set is owned by ApiKeyFields' `TOOL_FIELD_CONFIGS`. Per-field
        // saving spinners are tracked in `savingToolField` keyed by `${tool}.${field}`.
        const toolFields = TOOL_FIELD_CONFIGS[toolName] ?? [];
        const fieldStatus: FieldStatus = agenticToolStatus[toolName] ?? {};
        const savingForTool: Record<string, boolean> = Object.fromEntries(
          toolFields.map((c) => [c.field, !!savingToolField[`${toolName}.${c.field}`]])
        );
        const defaultsPane = (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Configure default settings for {displayNames[toolName]}. These will prepopulate
              session creation forms.
            </Typography.Paragraph>
            <Form form={currentForm} layout="vertical">
              <AgenticToolConfigForm
                agenticTool={toolName}
                mcpServerById={mcpServerById}
                showHelpText={false}
              />
            </Form>
            <div style={{ marginTop: 16 }}>
              <Button onClick={() => handleAgenticConfigClear(toolName)}>Clear Defaults</Button>
            </div>
          </>
        );

        // Tools with no auth/config fields (e.g. OpenCode) skip the tab strip entirely.
        if (toolFields.length === 0) {
          return defaultsPane;
        }

        const authPane = (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Per-user credentials and config for {displayNames[toolName]}. Encrypted at rest; take
              precedence over the daemon's global configuration and your global env vars.
            </Typography.Paragraph>
            <ApiKeyFields
              tool={toolName}
              fieldStatus={fieldStatus}
              onSave={(field, value) => handleToolFieldSave(toolName, field, value)}
              onClear={(field) => handleToolFieldClear(toolName, field)}
              saving={savingForTool}
              publicValues={
                user?.agentic_tools_public_values?.[toolName] as Record<string, string> | undefined
              }
            />
          </>
        );

        return (
          <Tabs
            defaultActiveKey="auth"
            items={[
              { key: 'auth', label: 'Authentication', children: authPane },
              { key: 'defaults', label: 'Defaults', children: defaultsPane },
            ]}
          />
        );
      }
      default:
        return null;
    }
  };

  // Get title for current section
  const getSectionTitle = () => {
    const titles: Record<string, string> = {
      general: 'General',
      'env-vars': 'Environment Variables',
      audio: 'Audio',
      'personal-api-keys': 'Agor API Tokens',
      'claude-code': 'Claude Code',
      codex: 'Codex',
      gemini: 'Gemini',
      opencode: 'OpenCode',
      copilot: 'GitHub Copilot',
    };
    return titles[activeTab] || 'User Settings';
  };

  return (
    <Modal
      title={null}
      open={open}
      onCancel={handleClose}
      footer={
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            gap: 8,
            padding: '12px 24px',
            background: token.colorBgContainer,
          }}
        >
          <Button onClick={handleClose}>Close</Button>
          <Button
            type="primary"
            onClick={handleModalSave}
            loading={
              activeTab in savingAgenticConfig
                ? savingAgenticConfig[activeTab as AgenticToolName]
                : false
            }
          >
            Save
          </Button>
        </div>
      }
      closable
      width="min(1050px, calc(100vw - 32px))"
      style={{ top: 40 }}
      styles={{
        wrapper: {
          padding: 0,
          overflow: 'hidden',
        },
        container: {
          padding: 0,
          borderRadius: 8,
          overflow: 'hidden',
        },
        header: {
          display: 'none',
        },
        body: {
          padding: 0,
          height: 'calc(100vh - 280px)',
          minHeight: 450,
          maxHeight: 650,
        },
        footer: {
          padding: 0,
          margin: 0,
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        },
      }}
      closeIcon={<CloseOutlined />}
    >
      <Layout style={{ height: '100%', background: token.colorBgContainer }}>
        <Sider
          width={200}
          style={{
            background: token.colorBgElevated,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            overflow: 'auto',
            padding: '20px 0',
          }}
        >
          <div
            style={{
              padding: '0 24px 16px',
              fontWeight: 600,
              fontSize: 18,
              color: token.colorText,
            }}
          >
            User Settings
          </div>
          <Menu
            mode="inline"
            selectedKeys={[activeTab]}
            onClick={({ key }) => setActiveTab(key)}
            items={menuItems}
            style={{
              border: 'none',
              background: 'transparent',
            }}
          />
        </Sider>
        <Content style={{ padding: '24px 32px', overflow: 'auto' }}>
          <Typography.Title level={4} style={{ marginTop: 0, marginBottom: 20 }}>
            {getSectionTitle()}
          </Typography.Title>
          {renderContent()}
        </Content>
      </Layout>
    </Modal>
  );
};
