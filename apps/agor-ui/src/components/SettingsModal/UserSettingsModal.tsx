import type { AgenticToolName, MCPServer, UpdateUserInput, User } from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import {
  Button,
  Flex,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
} from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { ApiKeyFields, type ApiKeyStatus } from '../ApiKeyFields';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { EnvVarEditor } from '../EnvVarEditor';
import { AudioSettingsTab } from './AudioSettingsTab';

export interface UserSettingsModalProps {
  open: boolean;
  onClose: () => void;
  user: User | null;
  mcpServerById: Map<string, MCPServer>;
  currentUser?: User | null;
  onUpdate?: (userId: string, updates: UpdateUserInput) => void;
}

export const UserSettingsModal: React.FC<UserSettingsModalProps> = ({
  open,
  onClose,
  user,
  mcpServerById,
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
  const [audioForm] = Form.useForm();

  // API key management state
  const [userApiKeyStatus, setUserApiKeyStatus] = useState<ApiKeyStatus>({
    ANTHROPIC_API_KEY: false,
    OPENAI_API_KEY: false,
    GEMINI_API_KEY: false,
  });
  const [savingApiKeys, setSavingApiKeys] = useState<Record<string, boolean>>({});

  // Environment variable management state
  const [userEnvVars, setUserEnvVars] = useState<Record<string, boolean>>({});
  const [savingEnvVars, setSavingEnvVars] = useState<Record<string, boolean>>({});

  // Saving state for agentic tool tabs
  const [savingAgenticConfig, setSavingAgenticConfig] = useState<Record<AgenticToolName, boolean>>({
    'claude-code': false,
    codex: false,
    gemini: false,
    opencode: false,
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
      });

      // Initialize agentic tool forms with user's defaults
      const defaults = userData.default_agentic_config;

      claudeForm.setFieldsValue({
        permissionMode:
          defaults?.['claude-code']?.permissionMode || getDefaultPermissionMode('claude-code'),
        modelConfig: defaults?.['claude-code']?.modelConfig,
        mcpServerIds: defaults?.['claude-code']?.mcpServerIds || [],
      });

      codexForm.setFieldsValue({
        permissionMode: defaults?.codex?.permissionMode || getDefaultPermissionMode('codex'),
        modelConfig: defaults?.codex?.modelConfig,
        mcpServerIds: defaults?.codex?.mcpServerIds || [],
        codexSandboxMode: defaults?.codex?.codexSandboxMode,
        codexApprovalPolicy: defaults?.codex?.codexApprovalPolicy,
        codexNetworkAccess: defaults?.codex?.codexNetworkAccess,
      });

      geminiForm.setFieldsValue({
        permissionMode: defaults?.gemini?.permissionMode || getDefaultPermissionMode('gemini'),
        modelConfig: defaults?.gemini?.modelConfig,
        mcpServerIds: defaults?.gemini?.mcpServerIds || [],
      });

      // Initialize audio form with user's preferences
      const audioPrefs = userData.preferences?.audio;
      audioForm.setFieldsValue({
        enabled: audioPrefs?.enabled ?? true,
        chime: audioPrefs?.chime ?? 'bell',
        volume: audioPrefs?.volume ?? 50,
        minDurationSeconds: audioPrefs?.minDurationSeconds ?? 5,
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

  // Load user's API key and env var status when modal opens
  // Include `open` in deps to rehydrate from server state each time modal opens
  useEffect(() => {
    if (!open) return;

    if (user?.api_keys) {
      setUserApiKeyStatus({
        ANTHROPIC_API_KEY: !!user.api_keys.ANTHROPIC_API_KEY,
        OPENAI_API_KEY: !!user.api_keys.OPENAI_API_KEY,
        GEMINI_API_KEY: !!user.api_keys.GEMINI_API_KEY,
      });
    } else {
      setUserApiKeyStatus({
        ANTHROPIC_API_KEY: false,
        OPENAI_API_KEY: false,
        GEMINI_API_KEY: false,
      });
    }

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
        onUpdate?.(user.user_id, updates);
        handleClose();
      })
      .catch((err) => {
        console.error('Validation failed:', err);
      });
  };

  // Handle API key save
  const handleApiKeySave = async (field: keyof ApiKeyStatus, value: string) => {
    if (!user) return;

    try {
      setSavingApiKeys((prev) => ({ ...prev, [field]: true }));
      await onUpdate?.(user.user_id, {
        api_keys: {
          [field]: value,
        },
      });
      setUserApiKeyStatus((prev) => ({ ...prev, [field]: true }));
    } catch (err) {
      console.error(`Failed to save ${field}:`, err);
      throw err;
    } finally {
      setSavingApiKeys((prev) => ({ ...prev, [field]: false }));
    }
  };

  // Handle API key clear
  const handleApiKeyClear = async (field: keyof ApiKeyStatus) => {
    if (!user) return;

    try {
      setSavingApiKeys((prev) => ({ ...prev, [field]: true }));
      await onUpdate?.(user.user_id, {
        api_keys: {
          [field]: null,
        },
      });
      setUserApiKeyStatus((prev) => ({ ...prev, [field]: false }));
    } catch (err) {
      console.error(`Failed to clear ${field}:`, err);
      throw err;
    } finally {
      setSavingApiKeys((prev) => ({ ...prev, [field]: false }));
    }
  };

  // Handle env var save
  const handleEnvVarSave = async (key: string, value: string) => {
    if (!user) return;

    try {
      setSavingEnvVars((prev) => ({ ...prev, [key]: true }));
      await onUpdate?.(user.user_id, {
        env_vars: { [key]: value },
      });
      setUserEnvVars((prev) => ({ ...prev, [key]: true }));
    } catch (err) {
      console.error(`Failed to save ${key}:`, err);
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
    };

    const currentForm = formMap[tool];

    try {
      setSavingAgenticConfig((prev) => ({ ...prev, [tool]: true }));

      const values = currentForm.getFieldsValue();

      const newConfig = {
        ...user.default_agentic_config,
        [tool]: {
          modelConfig: values.modelConfig,
          permissionMode: values.permissionMode,
          mcpServerIds: values.mcpServerIds,
          ...(tool === 'codex' && {
            codexSandboxMode: values.codexSandboxMode,
            codexApprovalPolicy: values.codexApprovalPolicy,
            codexNetworkAccess: values.codexNetworkAccess,
          }),
        },
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
    };

    const currentForm = formMap[tool];

    currentForm.setFieldsValue({
      modelConfig: undefined,
      permissionMode: getDefaultPermissionMode(tool),
      mcpServerIds: [],
      ...(tool === 'codex' && {
        codexSandboxMode: undefined,
        codexApprovalPolicy: undefined,
        codexNetworkAccess: undefined,
      }),
    });
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
      case 'api-keys':
      case 'env-vars':
        // These tabs save individually, just close
        handleClose();
        break;
      case 'audio':
        await handleAudioSave();
        break;
      case 'claude-code':
      case 'codex':
      case 'gemini':
        await handleAgenticConfigSave(activeTab as AgenticToolName);
        break;
    }
  };

  return (
    <Modal
      title="User Settings"
      open={open}
      onOk={handleModalSave}
      onCancel={handleClose}
      okText="Save"
      cancelText="Close"
      confirmLoading={
        activeTab === 'claude-code'
          ? savingAgenticConfig['claude-code']
          : activeTab === 'codex'
            ? savingAgenticConfig.codex
            : activeTab === 'gemini'
              ? savingAgenticConfig.gemini
              : false
      }
      width={900}
      styles={{
        body: {
          height: '500px',
          overflowY: 'auto',
        },
      }}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        style={{ marginTop: 16 }}
        items={[
          {
            key: 'general',
            label: 'General',
            children: (
              <Form form={form} layout="vertical" style={{ paddingTop: 8 }}>
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
                    currentUser?.role === 'admin'
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
                    disabled={currentUser?.role !== 'admin'}
                  />
                </Form.Item>

                <Form.Item
                  label="Password"
                  name="password"
                  help="Leave blank to keep current password"
                >
                  <Input.Password placeholder="••••••••" />
                </Form.Item>

                <Form.Item
                  label={
                    <Space size={4}>
                      Enable Live Event Stream
                      <Tag color="blue" style={{ fontSize: 10, marginLeft: 4 }}>
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
                  help={currentUser?.role !== 'admin' ? 'Maintained by administrators' : undefined}
                >
                  <Select disabled={currentUser?.role !== 'admin'}>
                    <Select.Option value="owner">Owner</Select.Option>
                    <Select.Option value="admin">Admin</Select.Option>
                    <Select.Option value="member">Member</Select.Option>
                    <Select.Option value="viewer">Viewer</Select.Option>
                  </Select>
                </Form.Item>
              </Form>
            ),
          },
          {
            key: 'api-keys',
            label: 'API Keys',
            children: (
              <div style={{ paddingTop: 8 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  Per-user API keys take precedence over global settings. These keys are encrypted
                  at rest.
                </Typography.Paragraph>
                <ApiKeyFields
                  keyStatus={userApiKeyStatus}
                  onSave={handleApiKeySave}
                  onClear={handleApiKeyClear}
                  saving={savingApiKeys}
                />
              </div>
            ),
          },
          {
            key: 'env-vars',
            label: 'Env Vars',
            children: (
              <div style={{ paddingTop: 8 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  Environment variables are encrypted at rest and available to all sessions for this
                  user.
                </Typography.Paragraph>
                <EnvVarEditor
                  envVars={userEnvVars}
                  onSave={handleEnvVarSave}
                  onDelete={handleEnvVarDelete}
                  loading={savingEnvVars}
                />
              </div>
            ),
          },
          {
            key: 'audio',
            label: 'Audio',
            children: (
              <div style={{ paddingTop: 8 }}>
                <AudioSettingsTab user={user} form={audioForm} />
              </div>
            ),
          },
          {
            key: 'claude-code',
            label: 'Claude Code',
            children: (
              <div style={{ paddingTop: 8 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  Configure default settings for Claude Code. These will prepopulate session
                  creation forms.
                </Typography.Paragraph>
                <Form form={claudeForm} layout="vertical">
                  <AgenticToolConfigForm
                    agenticTool="claude-code"
                    mcpServerById={mcpServerById}
                    showHelpText={false}
                  />
                </Form>
                <div style={{ marginTop: 16 }}>
                  <Button onClick={() => handleAgenticConfigClear('claude-code')}>
                    Clear Defaults
                  </Button>
                </div>
              </div>
            ),
          },
          {
            key: 'codex',
            label: 'Codex',
            children: (
              <div style={{ paddingTop: 8 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  Configure default settings for Codex. These will prepopulate session creation
                  forms.
                </Typography.Paragraph>
                <Form form={codexForm} layout="vertical">
                  <AgenticToolConfigForm
                    agenticTool="codex"
                    mcpServerById={mcpServerById}
                    showHelpText={false}
                  />
                </Form>
                <div style={{ marginTop: 16 }}>
                  <Button onClick={() => handleAgenticConfigClear('codex')}>Clear Defaults</Button>
                </div>
              </div>
            ),
          },
          {
            key: 'gemini',
            label: 'Gemini',
            children: (
              <div style={{ paddingTop: 8 }}>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  Configure default settings for Gemini. These will prepopulate session creation
                  forms.
                </Typography.Paragraph>
                <Form form={geminiForm} layout="vertical">
                  <AgenticToolConfigForm
                    agenticTool="gemini"
                    mcpServerById={mcpServerById}
                    showHelpText={false}
                  />
                </Form>
                <div style={{ marginTop: 16 }}>
                  <Button onClick={() => handleAgenticConfigClear('gemini')}>Clear Defaults</Button>
                </div>
              </div>
            ),
          },
        ]}
      />
    </Modal>
  );
};
