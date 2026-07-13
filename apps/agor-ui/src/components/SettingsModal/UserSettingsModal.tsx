import type {
  AgenticAuthMethod,
  AgenticToolConfigField,
  AgenticToolName,
  AgorClient,
  EnvVarMetadata,
  EnvVarScope,
  Group,
  GroupMembership,
  TenantAgenticToolName,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLE_OPTIONS, ROLES } from '@agor-live/client';
import {
  ApiOutlined,
  CloseOutlined,
  SettingOutlined,
  SoundOutlined,
  TeamOutlined,
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
  Popconfirm,
  Radio,
  Select,
  Space,
  Switch,
  Tabs,
  Tag,
  Typography,
  theme,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById } from '../../store/selectors';
import { buildAgenticToolCredentialPatch } from '../../utils/agenticToolCredentials';
import { DEFAULT_AUDIO_PREFERENCES } from '../../utils/audio';
import { searchableSelectProps, toGroupSelectOption } from '../../utils/selectSearch';
import {
  buildConfigFromFormValues,
  getClearedFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm';
import { ApiKeyFields, type FieldStatus, TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { EnvVarEditor } from '../EnvVarEditor';
import { SessionMcpServersField } from '../MCPServerSelect';
import { ToolIcon } from '../ToolIcon';
import { AudioSettingsTab } from './AudioSettingsTab';
import { syncGroupsForUser } from './groupMembershipSync';
import { PersonalApiKeysTab } from './PersonalApiKeysTab';
import { UserAgenticDefaultEditor } from './UserAgenticDefaultEditor';

const { Sider, Content } = Layout;

const AGENTIC_TOOL_TABS = [
  'claude-code',
  'claude-code-cli',
  'codex',
  'gemini',
  'opencode',
  'copilot',
  'cursor',
] as const satisfies readonly AgenticToolName[];

type AgenticConfigFormValues = Parameters<typeof buildConfigFromFormValues>[1] & {
  defaultSelectionSource?: 'workspace_default' | 'preset' | 'inline';
  defaultPresetId?: string;
  mcpServerIds?: string[];
};

const isAgenticToolTab = (value: string): value is AgenticToolName =>
  AGENTIC_TOOL_TABS.includes(value as AgenticToolName);

export interface UserSettingsModalProps {
  open: boolean;
  onClose: () => void;
  user: User | null;
  client: AgorClient | null;
  currentUser?: User | null;
  onUpdate?: (userId: string, updates: UpdateUserInput) => void;
  onRestartOnboarding?: () => void | Promise<void>;
  initialTab?: string;
}

export const UserSettingsModal: React.FC<UserSettingsModalProps> = ({
  open,
  onClose,
  user,
  client,
  currentUser,
  onUpdate,
  onRestartOnboarding,
  initialTab,
}) => {
  // Entity maps are read from the store rather than drilled through props so
  // the App shell doesn't have to forward them into every modal.
  const mcpServerById = useAgorStore(selectMcpServerById);
  const tenantToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);
  const visibleAgenticToolTabs = AGENTIC_TOOL_TABS.filter((tool) => {
    const canonical = tool === 'claude-code-cli' ? 'claude-code' : tool;
    return tenantToolSettings.get(canonical as TenantAgenticToolName)?.enabled !== false;
  });
  const [form] = Form.useForm();
  const [activeTab, setActiveTab] = useState<string>(initialTab ?? 'general');
  const initializedUserIdRef = useRef<string | null>(null);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  // Separate forms for each agentic tool tab
  const [claudeForm] = Form.useForm();
  const [claudeCliForm] = Form.useForm();
  const [codexForm] = Form.useForm();
  const [geminiForm] = Form.useForm();
  const [opencodeForm] = Form.useForm();
  const [copilotForm] = Form.useForm();
  const [cursorForm] = Form.useForm();
  const [audioForm] = Form.useForm();

  const agenticFormByTool = useMemo<Record<AgenticToolName, ReturnType<typeof Form.useForm>[0]>>(
    () => ({
      'claude-code': claudeForm,
      'claude-code-cli': claudeCliForm,
      codex: codexForm,
      gemini: geminiForm,
      opencode: opencodeForm,
      copilot: copilotForm,
      cursor: cursorForm,
    }),
    [claudeCliForm, claudeForm, codexForm, copilotForm, cursorForm, geminiForm, opencodeForm]
  );

  // Jump to initialTab each time the modal opens (e.g. from a banner deep-link).
  useEffect(() => {
    if (open && initialTab) setActiveTab(initialTab);
  }, [open, initialTab]);

  // Per-tool credential presence state, keyed `${tool}.${field}` for spinner
  // tracking. The actual presence map is rebuilt from `user.agentic_tools`
  // each time the modal opens.
  const [agenticToolStatus, setAgenticToolStatus] = useState<Record<AgenticToolName, FieldStatus>>({
    'claude-code': {},
    'claude-code-cli': {},
    codex: {},
    gemini: {},
    opencode: {},
    copilot: {},
    cursor: {},
  });
  const [savingToolField, setSavingToolField] = useState<Record<string, boolean>>({});
  const [agenticAuthMethods, setAgenticAuthMethods] = useState<
    Partial<Record<'claude-code' | 'codex', AgenticAuthMethod>>
  >({});

  // Environment variable management state (scope-aware, v0.5 env-var-access)
  const [userEnvVars, setUserEnvVars] = useState<Record<string, EnvVarMetadata>>({});
  const [savingEnvVars, setSavingEnvVars] = useState<Record<string, boolean>>({});
  const [availableGroups, setAvailableGroups] = useState<Group[]>([]);
  const [userGroupIds, setUserGroupIds] = useState<string[]>([]);
  const [loadingGroups, setLoadingGroups] = useState(false);
  const [groupsLoaded, setGroupsLoaded] = useState(false);
  const groupSelectOptions = useMemo(
    () =>
      [...availableGroups].sort((a, b) => a.name.localeCompare(b.name)).map(toGroupSelectOption),
    [availableGroups]
  );

  // Saving state for agentic tool tabs
  const [savingAgenticConfig, setSavingAgenticConfig] = useState<Record<AgenticToolName, boolean>>({
    'claude-code': false,
    'claude-code-cli': false,
    codex: false,
    gemini: false,
    opencode: false,
    copilot: false,
    cursor: false,
  });
  const [dirtyAgenticConfigTools, setDirtyAgenticConfigTools] = useState<Set<AgenticToolName>>(
    () => new Set()
  );
  const [agenticConfigDraftByTool, setAgenticConfigDraftByTool] = useState<
    Partial<Record<AgenticToolName, AgenticConfigFormValues>>
  >({});

  const markAgenticConfigDirty = useCallback((tool: AgenticToolName) => {
    setDirtyAgenticConfigTools((prev) => {
      if (prev.has(tool)) return prev;
      const next = new Set(prev);
      next.add(tool);
      return next;
    });
  }, []);

  // Initialize forms when user changes or modal opens. A deep-linked
  // `initialTab` must win here, otherwise this init (which runs after the
  // initialTab effect on open) would reset the modal back to 'general'.
  const initializeForms = useCallback(
    (userData: User) => {
      setActiveTab(initialTab ?? 'general');
      setDirtyAgenticConfigTools(new Set());
      setAgenticConfigDraftByTool({});

      form.setFieldsValue({
        email: userData.email,
        name: userData.name,
        emoji: userData.emoji,
        role: userData.role,
        unix_username: userData.unix_username,
        groupIds: [],
        eventStreamEnabled: userData.preferences?.eventStream?.enabled ?? true,
        useSlackAvatar: userData.preferences?.use_slack_avatar !== false,
        must_change_password: userData.must_change_password ?? false,
      });
    },
    [form, initialTab]
  );

  const loadUserGroups = useCallback(async () => {
    const userId = user?.user_id;
    if (!client || !userId || !isAdmin) {
      setAvailableGroups([]);
      setUserGroupIds([]);
      setGroupsLoaded(false);
      form.setFieldValue('groupIds', []);
      return;
    }

    setLoadingGroups(true);
    setGroupsLoaded(false);
    try {
      const [groups, memberships] = await Promise.all([
        client.service('groups').findAll({ query: { archived: false } }),
        client.service('group-memberships').findAll({ query: { user_id: userId } }),
      ]);
      const nextGroupIds = (memberships as GroupMembership[]).map(
        (membership) => membership.group_id
      );
      setAvailableGroups(groups as Group[]);
      setUserGroupIds(nextGroupIds);
      setGroupsLoaded(true);
      form.setFieldValue('groupIds', nextGroupIds);
    } catch (error) {
      console.error('Failed to load user groups:', error);
    } finally {
      setLoadingGroups(false);
    }
  }, [client, form, isAdmin, user?.user_id]);

  // Initialize when modal opens with user data
  useEffect(() => {
    if (!open) {
      initializedUserIdRef.current = null;
      return;
    }

    const userId = user?.user_id;
    if (!user || !userId || initializedUserIdRef.current === userId) return;

    initializedUserIdRef.current = userId;
    initializeForms(user);
    void loadUserGroups();
  }, [open, user, initializeForms, loadUserGroups]);

  // Hydrate tab-specific forms only after that tab has rendered its
  // corresponding <Form>. Calling setFieldsValue on never-mounted form
  // instances triggers Ant's "useForm is not connected" console warning.
  //
  // `agenticConfigDraftByTool` is intentionally NOT a dependency: it is read as
  // a "prefer the in-progress edit over the persisted config" source, but must
  // not itself re-trigger hydration. On tab switch the effect already re-runs
  // (via `activeTab`) with a fresh closure over the latest draft. Including the
  // draft in the deps caused a post-save revert (#1769): `saveAgenticConfigs`
  // clears the draft immediately after the patch resolves, which re-ran this
  // effect against a `user` prop that had not yet been refreshed by the realtime
  // `patched` event — reapplying the stale/empty config and wiping the just-saved
  // model. Reacting only to `activeTab`/`user`/`open` keeps hydration correct
  // while leaving the saved value in place until fresh `user` data arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is read-only here; see comment above.
  useEffect(() => {
    if (!open || !user) return;

    if (isAgenticToolTab(activeTab)) {
      agenticFormByTool[activeTab].setFieldsValue({
        ...(agenticConfigDraftByTool[activeTab] ??
          getFormValuesFromConfig(activeTab, user.default_agentic_config?.[activeTab])),
        mcpServerIds: user.default_mcp_server_ids ?? [],
        defaultSelectionSource:
          user.default_agentic_selection?.[activeTab]?.source ??
          (user.default_agentic_config?.[activeTab] ? 'inline' : 'workspace_default'),
        defaultPresetId:
          user.default_agentic_selection?.[activeTab]?.source === 'preset'
            ? user.default_agentic_selection[activeTab].preset_id
            : undefined,
      });
      return;
    }

    if (activeTab === 'audio') {
      const audioPrefs = user.preferences?.audio;
      audioForm.setFieldsValue({
        enabled: audioPrefs?.enabled ?? DEFAULT_AUDIO_PREFERENCES.enabled,
        chime: audioPrefs?.chime ?? DEFAULT_AUDIO_PREFERENCES.chime,
        volume: audioPrefs?.volume ?? DEFAULT_AUDIO_PREFERENCES.volume,
        minDurationSeconds:
          audioPrefs?.minDurationSeconds ?? DEFAULT_AUDIO_PREFERENCES.minDurationSeconds,
      });
    }
  }, [activeTab, audioForm, agenticFormByTool, open, user]);

  // Rehydrate per-tool credential presence and env-var metadata from the
  // server every time the modal opens, so flags reflect the latest patch.
  useEffect(() => {
    if (!open) return;

    const next: Record<AgenticToolName, FieldStatus> = {
      'claude-code': {},
      'claude-code-cli': {},
      codex: {},
      gemini: {},
      opencode: {},
      copilot: {},
      cursor: {},
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
    setAgenticAuthMethods(user?.agentic_auth_methods ?? {});

    if (user?.env_vars) {
      setUserEnvVars(user.env_vars);
    } else {
      setUserEnvVars({});
    }
  }, [open, user]);

  const handleClose = () => {
    form.resetFields();
    setAvailableGroups([]);
    setUserGroupIds([]);
    setGroupsLoaded(false);
    setDirtyAgenticConfigTools(new Set());
    setAgenticConfigDraftByTool({});
    setActiveTab('general');
    onClose();
  };

  const syncUserGroups = async (nextGroupIds: string[]) => {
    if (!client || !user || !isAdmin || !groupsLoaded) return;
    await syncGroupsForUser(client, user.user_id, userGroupIds, nextGroupIds);
    setUserGroupIds(nextGroupIds);
  };

  const getAgenticConfigToolsToSave = (activeTool?: AgenticToolName): AgenticToolName[] => [
    ...new Set([
      ...dirtyAgenticConfigTools,
      ...(activeTool ? [activeTool] : []),
    ] satisfies AgenticToolName[]),
  ];

  const saveAgenticConfigs = async (tools: AgenticToolName[]) => {
    if (!user || tools.length === 0) return;

    const nextConfig: NonNullable<UpdateUserInput['default_agentic_config']> = {
      ...(user.default_agentic_config ?? {}),
    };
    const nextSelections: NonNullable<UpdateUserInput['default_agentic_selection']> = {
      ...(user.default_agentic_selection ?? {}),
    };

    for (const tool of tools) {
      const values: AgenticConfigFormValues =
        agenticConfigDraftByTool[tool] ??
        (agenticFormByTool[tool].getFieldsValue() as AgenticConfigFormValues);
      if (values.defaultSelectionSource === 'inline') {
        nextConfig[tool] = buildConfigFromFormValues(tool, values);
      }
      nextSelections[tool] =
        values.defaultSelectionSource === 'preset' && values.defaultPresetId
          ? { source: 'preset', preset_id: values.defaultPresetId as never }
          : values.defaultSelectionSource === 'inline'
            ? { source: 'inline' }
            : { source: 'workspace_default' };
    }

    const mcpSourceTool = tools[0];
    const defaultMcpServerIds = mcpSourceTool
      ? (agenticFormByTool[mcpSourceTool].getFieldValue('mcpServerIds') as string[] | undefined)
      : user.default_mcp_server_ids;
    await onUpdate?.(user.user_id, {
      default_agentic_config: nextConfig,
      default_agentic_selection: nextSelections,
      default_mcp_server_ids: defaultMcpServerIds ?? [],
    });

    setDirtyAgenticConfigTools((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      for (const tool of tools) {
        next.delete(tool);
      }
      return next;
    });
    setAgenticConfigDraftByTool((prev) => {
      const next = { ...prev };
      for (const tool of tools) {
        delete next[tool];
      }
      return next;
    });
  };

  const saveDirtyAgenticConfigs = async () => {
    await saveAgenticConfigs(getAgenticConfigToolsToSave());
  };

  const handleUpdate = async (): Promise<boolean> => {
    if (!user) return false;

    try {
      await form.validateFields(['email', 'name', 'emoji', 'role', 'unix_username']);
      const values = form.getFieldsValue();
      const nextPreferences: NonNullable<UpdateUserInput['preferences']> = {
        ...user.preferences,
        eventStream: {
          enabled: values.eventStreamEnabled ?? true,
        },
      };
      if (values.useSlackAvatar === false) {
        nextPreferences.use_slack_avatar = false;
      } else {
        delete nextPreferences.use_slack_avatar;
      }

      const updates: UpdateUserInput = {
        email: values.email,
        name: values.name,
        emoji: values.emoji,
        role: values.role,
        unix_username: values.unix_username,
        preferences: nextPreferences,
      };
      if (values.password?.trim()) {
        updates.password = values.password;
      }
      // Only admins can set must_change_password, and only for other users
      if (hasMinimumRole(currentUser?.role, ROLES.ADMIN) && user.user_id !== currentUser?.user_id) {
        updates.must_change_password = values.must_change_password;
      }
      await onUpdate?.(user.user_id, updates);
      form.setFieldValue('password', '');
      await syncUserGroups(values.groupIds || []);
      await saveDirtyAgenticConfigs();
      return true;
    } catch (err) {
      console.error('Validation failed:', err);
      return false;
    }
  };

  // Persist a per-tool credential field. Patch is shaped as
  // `{ agentic_tools: { [tool]: { [field]: value | null } } }` — the daemon
  // service merges only the touched fields and encrypts at rest.
  const handleToolFieldSave = async (
    tool: AgenticToolName,
    field: AgenticToolConfigField,
    value: string
  ): Promise<void> => {
    if (!user) return;
    const spinnerKey = `${tool}.${field}`;

    try {
      setSavingToolField((prev) => ({ ...prev, [spinnerKey]: true }));
      const patch = buildAgenticToolCredentialPatch(tool, field, value);
      await onUpdate?.(user.user_id, patch);
      if (patch.agentic_auth_methods) {
        setAgenticAuthMethods((current) => ({ ...current, ...patch.agentic_auth_methods }));
      }
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
  const handleToolFieldClear = async (
    tool: AgenticToolName,
    field: AgenticToolConfigField
  ): Promise<void> => {
    if (!user) return;
    const spinnerKey = `${tool}.${field}`;

    try {
      setSavingToolField((prev) => ({ ...prev, [spinnerKey]: true }));
      await onUpdate?.(user.user_id, buildAgenticToolCredentialPatch(tool, field, null));
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

  const handleAuthMethodChange = async (
    tool: 'claude-code' | 'codex',
    method: AgenticAuthMethod
  ) => {
    if (!user) return;
    const next = { ...agenticAuthMethods, [tool]: method };
    setAgenticAuthMethods(next);
    try {
      await onUpdate?.(user.user_id, { agentic_auth_methods: next });
    } catch (error) {
      setAgenticAuthMethods(user.agentic_auth_methods ?? {});
      throw error;
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

    const toolsToSave = getAgenticConfigToolsToSave(tool);

    try {
      setSavingAgenticConfig((prev) => {
        const next = { ...prev };
        for (const toolName of toolsToSave) next[toolName] = true;
        return next;
      });

      await saveAgenticConfigs(toolsToSave);
    } catch (err) {
      console.error(`Failed to save ${tool} config:`, err);
      throw err;
    } finally {
      setSavingAgenticConfig((prev) => {
        const next = { ...prev };
        for (const toolName of toolsToSave) next[toolName] = false;
        return next;
      });
    }
  };

  // Handle agentic tool config clear
  const handleAgenticConfigClear = (tool: AgenticToolName) => {
    const clearedValues = getClearedFormValues(tool);
    agenticFormByTool[tool].setFieldsValue(clearedValues);
    setAgenticConfigDraftByTool((prev) => ({ ...prev, [tool]: clearedValues }));
    markAgenticConfigDirty(tool);
  };

  const handleAudioSave = async (): Promise<boolean> => {
    if (!user || !onUpdate) return false;

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

      await onUpdate(user.user_id, {
        preferences: updatedPreferences,
      });

      await saveDirtyAgenticConfigs();
      return true;
    } catch (error) {
      console.error('Failed to save audio settings:', error);
      return false;
    }
  };

  // Unified save handler that routes based on active tab
  const handleModalSave = async () => {
    if (!user) return;

    switch (activeTab) {
      case 'general':
        if (!(await handleUpdate())) return;
        break;
      case 'env-vars':
      case 'personal-api-keys':
        // These tabs save inline; keep the user on the current section.
        await saveDirtyAgenticConfigs();
        break;
      case 'groups':
        await syncUserGroups(form.getFieldValue('groupIds') || []);
        await saveDirtyAgenticConfigs();
        break;
      case 'audio':
        if (!(await handleAudioSave())) return;
        break;
      case 'claude-code':
      case 'claude-code-cli':
      case 'codex':
      case 'gemini':
      case 'opencode':
      case 'copilot':
      case 'cursor':
        await handleAgenticConfigSave(activeTab as AgenticToolName);
        break;
    }

    // The footer action is Save-and-close. Tab-specific controls (credentials,
    // environment variables, and API tokens) save inline and intentionally do
    // not come through this handler, so those flows remain on the current tab.
    handleClose();
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
        ...(isAdmin
          ? [
              {
                key: 'groups',
                label: 'Groups',
                icon: <TeamOutlined />,
              },
            ]
          : []),
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
          icon: <ToolIcon tool="claude-code" size={18} />,
        },
        {
          key: 'codex',
          label: 'Codex',
          icon: <ToolIcon tool="codex" size={18} />,
        },
        {
          key: 'gemini',
          label: 'Gemini',
          icon: <ToolIcon tool="gemini" size={18} />,
        },
        {
          key: 'opencode',
          label: 'OpenCode',
          icon: <ToolIcon tool="opencode" size={18} />,
        },
        {
          key: 'cursor',
          label: 'Cursor SDK',
          icon: <ToolIcon tool="cursor" size={18} />,
        },
        {
          key: 'copilot',
          label: 'GitHub Copilot',
          icon: <ToolIcon tool="copilot" size={18} />,
        },
      ].filter((item) => visibleAgenticToolTabs.includes(item.key as AgenticToolName)),
    },
  ];

  // Render content based on active section
  const renderContent = () => {
    switch (activeTab) {
      case 'general':
        return (
          <>
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
                label="Use Slack avatar when available"
                name="useSlackAvatar"
                valuePropName="checked"
                tooltip="When enabled, Agor shows your Slack-synced profile image. Turn this off to keep using your emoji tile."
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
                <Select
                  disabled={!hasMinimumRole(currentUser?.role, ROLES.ADMIN)}
                  options={ROLE_OPTIONS.map((opt) => ({
                    value: opt.value,
                    label: opt.label,
                    title: opt.description,
                  }))}
                />
              </Form.Item>

              {isAdmin && (
                <Form.Item
                  label="Groups"
                  name="groupIds"
                  help="Group memberships affect group-aware branch permissions."
                >
                  <Select
                    mode="multiple"
                    loading={loadingGroups}
                    disabled={!groupsLoaded && !loadingGroups}
                    placeholder="Select groups..."
                    options={groupSelectOptions}
                    {...searchableSelectProps}
                  />
                </Form.Item>
              )}

              {/* Only show for admins editing other users */}
              {hasMinimumRole(currentUser?.role, ROLES.ADMIN) &&
                user &&
                user.user_id !== currentUser?.user_id && (
                  <Form.Item name="must_change_password" valuePropName="checked">
                    <Checkbox>Force password change on next login</Checkbox>
                  </Form.Item>
                )}
            </Form>

            {onRestartOnboarding && user?.user_id === currentUser?.user_id && (
              <div
                style={{
                  marginTop: 24,
                  paddingTop: 20,
                  borderTop: `1px solid ${token.colorBorderSecondary}`,
                }}
              >
                <Typography.Title level={5} style={{ marginTop: 0 }}>
                  Onboarding
                </Typography.Title>
                <Typography.Paragraph type="secondary">
                  Reopen the AI teammate setup wizard from the beginning. Existing repos, boards,
                  branches, and credentials stay in place.
                </Typography.Paragraph>
                <Popconfirm
                  title="Restart onboarding?"
                  description="This clears saved wizard progress and opens onboarding again."
                  okText="Restart"
                  cancelText="Cancel"
                  onConfirm={onRestartOnboarding}
                >
                  <Button>Restart onboarding</Button>
                </Popconfirm>
              </div>
            )}
          </>
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
                  precedence over generic user environment variables and is scoped so credentials
                  never leak across SDKs.
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
      case 'groups':
        return (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Add or remove this user from admin-managed groups.
            </Typography.Paragraph>
            <Form form={form} layout="vertical">
              <Form.Item
                label="Groups"
                name="groupIds"
                help="Group memberships affect group-aware branch permissions."
              >
                <Select
                  mode="multiple"
                  loading={loadingGroups}
                  disabled={!groupsLoaded && !loadingGroups}
                  placeholder="Select groups..."
                  options={groupSelectOptions}
                  {...searchableSelectProps}
                />
              </Form.Item>
            </Form>
          </>
        );
      case 'personal-api-keys':
        return <PersonalApiKeysTab client={client} />;
      case 'claude-code':
      case 'claude-code-cli':
      case 'codex':
      case 'gemini':
      case 'opencode':
      case 'copilot':
      case 'cursor': {
        const toolName = activeTab as AgenticToolName;
        const currentForm = agenticFormByTool[toolName];
        const displayNames: Record<AgenticToolName, string> = {
          'claude-code': 'Claude Code',
          'claude-code-cli': 'Claude Code CLI',
          codex: 'Codex',
          gemini: 'Gemini',
          opencode: 'OpenCode',
          copilot: 'Copilot',
          cursor: 'Cursor SDK',
        };
        const canonicalTool = (
          toolName === 'claude-code-cli' ? 'claude-code' : toolName
        ) as TenantAgenticToolName;
        const credentialToolName: AgenticToolName =
          toolName === 'claude-code-cli' ? 'claude-code' : toolName;
        // Field set is owned by ApiKeyFields' `TOOL_FIELD_CONFIGS`. Claude and Codex
        // expose an explicit method so dormant credentials are never selected by accident.
        const allToolFields = TOOL_FIELD_CONFIGS[toolName] ?? [];
        const fieldStatus: FieldStatus = agenticToolStatus[credentialToolName] ?? {};
        const authMethod =
          canonicalTool === 'claude-code'
            ? (agenticAuthMethods['claude-code'] ??
              (fieldStatus.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : 'api_key'))
            : canonicalTool === 'codex'
              ? (agenticAuthMethods.codex ?? 'api_key')
              : undefined;
        const toolFields = allToolFields.filter((field) => {
          if (canonicalTool === 'claude-code') {
            return authMethod === 'subscription'
              ? field.field === 'CLAUDE_CODE_OAUTH_TOKEN'
              : field.field !== 'CLAUDE_CODE_OAUTH_TOKEN';
          }
          return canonicalTool !== 'codex' || authMethod === 'api_key';
        });
        const tenantSettings = tenantToolSettings.get(canonicalTool);
        const resolutionPolicy = tenantSettings?.resolution_policy ?? 'user_preferred';
        const personalConfigured =
          (canonicalTool === 'codex' && authMethod === 'subscription') ||
          toolFields.some(
            ({ field }) => fieldStatus[field] && !String(field).endsWith('_BASE_URL')
          );
        const workspaceConfigured = Object.entries(tenantSettings?.connection ?? {}).some(
          ([field, status]) => status?.configured && !field.endsWith('_BASE_URL')
        );
        const effectiveSource =
          resolutionPolicy === 'user_required'
            ? personalConfigured
              ? 'Personal configuration'
              : 'Unavailable'
            : resolutionPolicy === 'tenant_required'
              ? workspaceConfigured
                ? 'Workspace configuration'
                : 'Unavailable'
              : resolutionPolicy === 'tenant_preferred'
                ? workspaceConfigured
                  ? 'Workspace configuration'
                  : personalConfigured
                    ? 'Personal configuration'
                    : 'Unavailable'
                : personalConfigured
                  ? 'Personal configuration'
                  : workspaceConfigured
                    ? 'Workspace configuration'
                    : 'Unavailable';
        const savingForTool: Partial<Record<AgenticToolConfigField, boolean>> = Object.fromEntries(
          toolFields.map((c) => [c.field, !!savingToolField[`${credentialToolName}.${c.field}`]])
        );
        const defaultsPane = (
          <>
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Configure default settings for {displayNames[toolName]}. These will prepopulate
              session creation forms.
            </Typography.Paragraph>
            <Form
              key={toolName}
              form={currentForm}
              layout="vertical"
              onValuesChange={(_, allValues) => {
                setAgenticConfigDraftByTool((prev) => ({ ...prev, [toolName]: allValues }));
                markAgenticConfigDirty(toolName);
              }}
            >
              <UserAgenticDefaultEditor tool={toolName} client={client} isAdmin={isAdmin} />
              <SessionMcpServersField mcpServerById={mcpServerById} showHelpText={false} />
            </Form>
            <div style={{ marginTop: 16 }}>
              <Button onClick={() => handleAgenticConfigClear(toolName)}>Clear Defaults</Button>
            </div>
          </>
        );

        // Tools with no auth/config fields (e.g. OpenCode) skip the tab strip entirely.
        if (allToolFields.length === 0) {
          return defaultsPane;
        }

        const personalPolicyDescription =
          resolutionPolicy === 'user_required'
            ? 'Your personal configuration is required. Workspace credentials will not be used.'
            : resolutionPolicy === 'user_preferred'
              ? 'Your personal configuration is used first, with workspace configuration as fallback.'
              : 'Workspace configuration is used first. Your personal configuration is retained as fallback.';
        const managedByWorkspace = resolutionPolicy === 'tenant_required';
        const authPane = (
          <>
            <Alert
              type={effectiveSource === 'Unavailable' ? 'warning' : 'info'}
              showIcon
              title={`Effective source: ${effectiveSource}`}
              description={
                managedByWorkspace
                  ? 'Authentication is managed by this workspace. Personal configuration is never used.'
                  : personalPolicyDescription
              }
              style={{ marginBottom: 16 }}
            />
            {managedByWorkspace ? (
              personalConfigured && (
                <Space direction="vertical">
                  <Typography.Text type="secondary">
                    Saved personal configuration is inactive and will be retained if the workspace
                    policy changes.
                  </Typography.Text>
                  <Popconfirm
                    title="Delete saved personal configuration?"
                    description="This permanently removes your saved credentials for this tool."
                    onConfirm={async () => {
                      for (const field of allToolFields) {
                        if (fieldStatus[field.field]) {
                          await handleToolFieldClear(credentialToolName, field.field);
                        }
                      }
                      if (canonicalTool === 'codex') {
                        await handleAuthMethodChange('codex', 'api_key');
                      }
                    }}
                  >
                    <Button danger>Delete saved personal configuration</Button>
                  </Popconfirm>
                </Space>
              )
            ) : (
              <>
                <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
                  Personal credentials are encrypted at rest and injected only into the agent
                  runtime.
                </Typography.Paragraph>
                {(canonicalTool === 'claude-code' || canonicalTool === 'codex') && (
                  <Radio.Group
                    value={authMethod}
                    onChange={(event) =>
                      void handleAuthMethodChange(canonicalTool, event.target.value)
                    }
                    style={{ marginBottom: 16 }}
                  >
                    <Radio.Button value="subscription">
                      {canonicalTool === 'codex' ? 'ChatGPT subscription' : 'Claude subscription'}
                    </Radio.Button>
                    <Radio.Button value="api_key">API key</Radio.Button>
                  </Radio.Group>
                )}
                {canonicalTool === 'codex' && authMethod === 'subscription' ? (
                  <Alert
                    type="info"
                    showIcon
                    title="Use Codex CLI subscription authentication"
                    description="Agor will use the Codex CLI login belonging to this session's Unix user. Run `codex login` in a terminal as that same user. This declaration does not prove that the login is still valid."
                  />
                ) : (
                  <ApiKeyFields
                    tool={toolName}
                    fields={toolFields}
                    fieldStatus={fieldStatus}
                    onSave={(field, value) => handleToolFieldSave(credentialToolName, field, value)}
                    onClear={(field) => handleToolFieldClear(credentialToolName, field)}
                    saving={savingForTool}
                    publicValues={
                      user?.agentic_tools_public_values?.[credentialToolName] as
                        | Partial<Record<AgenticToolConfigField, string>>
                        | undefined
                    }
                  />
                )}
              </>
            )}
          </>
        );

        return (
          <Tabs
            defaultActiveKey="auth"
            items={[
              { key: 'auth', label: 'Authentication', children: authPane },
              { key: 'defaults', label: 'Session Defaults', children: defaultsPane },
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
      groups: 'Groups',
      'personal-api-keys': 'Agor API Tokens',
      'claude-code': 'Claude Code',
      codex: 'Codex',
      gemini: 'Gemini',
      opencode: 'OpenCode',
      cursor: 'Cursor SDK',
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
      {/* Keep inactive tab form instances connected to Ant Form. Without these
          lightweight hidden connectors, calling form methods while switching
          tabs can produce noisy "useForm is not connected" console warnings. */}
      <div hidden aria-hidden="true">
        {activeTab !== 'audio' && <Form component={false} form={audioForm} />}
        {visibleAgenticToolTabs.map((tool) =>
          activeTab === tool ? null : (
            <Form key={tool} component={false} form={agenticFormByTool[tool]} />
          )
        )}
      </div>
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
