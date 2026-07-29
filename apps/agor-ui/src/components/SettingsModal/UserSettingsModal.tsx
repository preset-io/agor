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
import { AGENTIC_TOOL_DISPLAY_NAMES, hasMinimumRole, ROLE_OPTIONS, ROLES } from '@agor-live/client';
import {
  BellOutlined,
  CheckCircleFilled,
  KeyOutlined,
  LockOutlined,
  MinusCircleOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  ThunderboltOutlined,
  UserOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  ConfigProvider,
  Divider,
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
import { matchesSettingsSearch } from '../../utils/settingsSearch';
import {
  buildConfigFromFormValues,
  getClearedFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm';
import { ApiKeyFields, type FieldStatus, TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { CodexAuthSettings } from '../CodexAuth';
import { FormEmojiPickerInput } from '../EmojiPickerInput';
import { EnvVarEditor } from '../EnvVarEditor';
import { HighlightMatch } from '../HighlightMatch';
import { SessionMcpServersField } from '../MCPServerSelect';
import { ToolIcon } from '../ToolIcon';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { AudioSettingsTab } from './AudioSettingsTab';
import { syncGroupsForUser } from './groupMembershipSync';
import { PersonalApiKeysTab } from './PersonalApiKeysTab';
import { FieldRow, PanelHeader, SectionDivider } from './panelPrimitives';
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

// Panels that own the shared `form` instance. Every other panel (tokens,
// env-vars, providers) keeps the instance alive via a hidden connector.
const MAIN_FORM_KEYS = ['profile', 'security', 'preferences', 'access'] as const;

const PROVIDER_KEY_PREFIX = 'provider:';

type ProviderStatus = 'connected' | 'not_connected' | 'workspace_managed';
type ProviderSubtab = 'auth' | 'defaults';

const PROVIDER_STATUS_LABEL: Record<ProviderStatus, string> = {
  connected: 'Connected',
  not_connected: 'Not connected',
  workspace_managed: 'Managed by workspace',
};

// Visually-hidden text so a provider's status is never conveyed by the dot
// color alone: assistive tech reads the label while sighted users see the dot.
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

type AgenticConfigFormValues = Parameters<typeof buildConfigFromFormValues>[1] & {
  defaultSelectionSource?: 'workspace_default' | 'preset' | 'inline';
  defaultPresetId?: string;
  mcpServerIds?: string[];
};

const isAgenticToolTab = (value: string): value is AgenticToolName =>
  AGENTIC_TOOL_TABS.includes(value as AgenticToolName);

const providerKeyFor = (tool: AgenticToolName): string => `${PROVIDER_KEY_PREFIX}${tool}`;
const toolFromProviderKey = (key: string): AgenticToolName =>
  key.slice(PROVIDER_KEY_PREFIX.length) as AgenticToolName;

// Legacy deep-link keys (pre-redesign tab ids) mapped onto their new panels so
// existing `initialTab` callers keep landing in the right place.
const LEGACY_KEY_MAP: Record<string, string> = {
  general: 'profile',
  audio: 'preferences',
  groups: 'access',
  'personal-api-keys': 'tokens',
};

const normalizeInitialKey = (tab?: string): string => {
  if (!tab) return 'profile';
  if (isAgenticToolTab(tab)) return providerKeyFor(tab);
  return LEGACY_KEY_MAP[tab] ?? tab;
};

// Flat index powering the modal's global search: every setting maps to the
// panel that hosts it. Provider rows are appended per enabled tool at runtime.
// NOTE: when adding a new setting to any panel, add an entry here (with search
// keywords) so it stays findable.
interface SettingIndexEntry {
  label: string;
  keywords?: string;
  panelKey: string;
}

const STATIC_PANEL_TITLES: Record<string, string> = {
  profile: 'Profile',
  security: 'Security',
  preferences: 'Preferences',
  tokens: 'API tokens',
  'env-vars': 'Environment variables',
  access: 'Groups & access',
};

const panelTitleForKey = (key: string): string =>
  key.startsWith(PROVIDER_KEY_PREFIX)
    ? AGENTIC_TOOL_DISPLAY_NAMES[toolFromProviderKey(key)]
    : (STATIC_PANEL_TITLES[key] ?? key);

// A "page" hit: the entry represents a nav tab/panel AND the query matched its
// visible name (a keyword-only tab hit is not treated as a page match).
const isPageMatch = (entry: SettingIndexEntry, query: string): boolean => {
  const labelLc = entry.label.toLowerCase();
  return labelLc === panelTitleForKey(entry.panelKey).toLowerCase() && labelLc.includes(query);
};

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
  const { token } = theme.useToken();

  // Entity maps are read from the store rather than drilled through props so
  // the App shell doesn't have to forward them into every modal.
  const mcpServerById = useAgorStore(selectMcpServerById);
  const tenantToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);
  const visibleAgenticToolTabs = useMemo(
    () =>
      AGENTIC_TOOL_TABS.filter((tool) => {
        const canonical = tool === 'claude-code-cli' ? 'claude-code' : tool;
        return tenantToolSettings.get(canonical as TenantAgenticToolName)?.enabled !== false;
      }),
    [tenantToolSettings]
  );

  const [form] = Form.useForm();
  const [activeKey, setActiveKey] = useState<string>(() => normalizeInitialKey(initialTab));
  const [search, setSearch] = useState('');
  const [providerSubtab, setProviderSubtab] = useState<ProviderSubtab>('auth');
  const [savingModal, setSavingModal] = useState(false);
  const initializedUserIdRef = useRef<string | null>(null);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const isEditingOther = !!user && !!currentUser && user.user_id !== currentUser.user_id;
  const isSelf = !!user && !!currentUser && user.user_id === currentUser.user_id;

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
    if (open && initialTab) setActiveKey(normalizeInitialKey(initialTab));
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
  // initialTab effect on open) would reset the modal back to Profile.
  const initializeForms = useCallback(
    (userData: User) => {
      setActiveKey(normalizeInitialKey(initialTab));
      setDirtyAgenticConfigTools(new Set());
      setAgenticConfigDraftByTool({});
      setSearch('');

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

  const activeTool: AgenticToolName | null = activeKey.startsWith(PROVIDER_KEY_PREFIX)
    ? toolFromProviderKey(activeKey)
    : null;

  // Reset (or force) the provider sub-tab whenever the active provider changes.
  // Tools with no auth fields (e.g. OpenCode) only have Session Defaults, so
  // they land there directly.
  useEffect(() => {
    if (!activeTool) return;
    const hasAuth = (TOOL_FIELD_CONFIGS[activeTool] ?? []).length > 0;
    setProviderSubtab(hasAuth ? 'auth' : 'defaults');
  }, [activeTool]);

  // Hydrate tab-specific forms only after that tab has rendered its
  // corresponding <Form>. Calling setFieldsValue on never-mounted form
  // instances triggers Ant's "useForm is not connected" console warning.
  //
  // `agenticConfigDraftByTool` is intentionally NOT a dependency: it is read as
  // a "prefer the in-progress edit over the persisted config" source, but must
  // not itself re-trigger hydration. On tab switch the effect already re-runs
  // (via `activeKey`) with a fresh closure over the latest draft. Including the
  // draft in the deps caused a post-save revert (#1769): `saveAgenticConfigs`
  // clears the draft immediately after the patch resolves, which re-ran this
  // effect against a `user` prop that had not yet been refreshed by the realtime
  // `patched` event — reapplying the stale/empty config and wiping the just-saved
  // model. Reacting only to `activeKey`/`user`/`open` keeps hydration correct
  // while leaving the saved value in place until fresh `user` data arrives.
  // biome-ignore lint/correctness/useExhaustiveDependencies: draft is read-only here; see comment above.
  useEffect(() => {
    if (!open || !user) return;

    if (activeTool) {
      agenticFormByTool[activeTool].setFieldsValue({
        ...(agenticConfigDraftByTool[activeTool] ??
          getFormValuesFromConfig(activeTool, user.default_agentic_config?.[activeTool])),
        mcpServerIds: user.default_mcp_server_ids ?? [],
        defaultSelectionSource:
          user.default_agentic_selection?.[activeTool]?.source ??
          (user.default_agentic_config?.[activeTool] ? 'inline' : 'workspace_default'),
        defaultPresetId:
          user.default_agentic_selection?.[activeTool]?.source === 'preset'
            ? user.default_agentic_selection[activeTool].preset_id
            : undefined,
      });
      return;
    }

    if (activeKey === 'preferences') {
      const audioPrefs = user.preferences?.audio;
      audioForm.setFieldsValue({
        enabled: audioPrefs?.enabled ?? DEFAULT_AUDIO_PREFERENCES.enabled,
        chime: audioPrefs?.chime ?? DEFAULT_AUDIO_PREFERENCES.chime,
        volume: audioPrefs?.volume ?? DEFAULT_AUDIO_PREFERENCES.volume,
        minDurationSeconds:
          audioPrefs?.minDurationSeconds ?? DEFAULT_AUDIO_PREFERENCES.minDurationSeconds,
      });
    }
  }, [activeKey, activeTool, audioForm, agenticFormByTool, open, user]);

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
    setActiveKey('profile');
    setSearch('');
    onClose();
  };

  const syncUserGroups = async (nextGroupIds: string[]) => {
    if (!client || !user || !isAdmin || !groupsLoaded) return;
    await syncGroupsForUser(client, user.user_id, userGroupIds, nextGroupIds);
    setUserGroupIds(nextGroupIds);
  };

  const getAgenticConfigToolsToSave = (activeToolName?: AgenticToolName): AgenticToolName[] => [
    ...new Set([
      ...dirtyAgenticConfigTools,
      ...(activeToolName ? [activeToolName] : []),
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

  // Profile panel: identity fields + Slack-avatar preference.
  const handleProfileSave = async (): Promise<boolean> => {
    if (!user) return false;

    try {
      await form.validateFields(['email', 'name', 'emoji', 'role']);
      const values = form.getFieldsValue(['email', 'name', 'emoji', 'role', 'useSlackAvatar']);
      const nextPreferences: NonNullable<UpdateUserInput['preferences']> = { ...user.preferences };
      if (values.useSlackAvatar === false) {
        nextPreferences.use_slack_avatar = false;
      } else {
        delete nextPreferences.use_slack_avatar;
      }

      await onUpdate?.(user.user_id, {
        email: values.email,
        name: values.name,
        emoji: values.emoji,
        role: values.role,
        preferences: nextPreferences,
      });
      return true;
    } catch (err) {
      console.error('Validation failed:', err);
      return false;
    }
  };

  // Security panel: password + Unix username (Unix editable by admins only).
  const handleSecuritySave = async (): Promise<boolean> => {
    if (!user) return false;

    try {
      await form.validateFields(['unix_username']);
      const values = form.getFieldsValue(['unix_username', 'password']);
      const updates: UpdateUserInput = { unix_username: values.unix_username };
      if (values.password?.trim()) {
        updates.password = values.password;
      }
      await onUpdate?.(user.user_id, updates);
      form.setFieldValue('password', '');
      return true;
    } catch (err) {
      console.error('Validation failed:', err);
      return false;
    }
  };

  // Preferences panel: audio/chime settings + live event stream toggle. Each
  // save spreads the current `preferences` so it never clobbers the other
  // panels' keys (e.g. Profile's `use_slack_avatar`).
  const handlePreferencesSave = async (): Promise<boolean> => {
    if (!user || !onUpdate) return false;

    try {
      const audioValues = audioForm.getFieldsValue();
      await onUpdate(user.user_id, {
        preferences: {
          ...user.preferences,
          audio: {
            enabled: audioValues.enabled,
            chime: audioValues.chime,
            volume: audioValues.volume,
            minDurationSeconds: audioValues.minDurationSeconds,
          },
          eventStream: {
            enabled: form.getFieldValue('eventStreamEnabled') ?? true,
          },
        },
      });
      return true;
    } catch (error) {
      console.error('Failed to save preferences:', error);
      return false;
    }
  };

  // Access panel (admin-only): group membership + force-password (other users).
  const handleAccessSave = async (): Promise<boolean> => {
    if (!user) return false;

    try {
      await syncUserGroups(form.getFieldValue('groupIds') || []);
      if (isAdmin && isEditingOther) {
        await onUpdate?.(user.user_id, {
          must_change_password: form.getFieldValue('must_change_password'),
        });
      }
      return true;
    } catch (err) {
      console.error('Failed to save access settings:', err);
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

  // Handle agentic tool config save. The footer's shared saving state guards the
  // in-flight UI; this only needs to flush the dirty tools and surface errors.
  const handleAgenticConfigSave = async (tool: AgenticToolName) => {
    if (!user) return;

    try {
      await saveAgenticConfigs(getAgenticConfigToolsToSave(tool));
    } catch (err) {
      console.error(`Failed to save ${tool} config:`, err);
      throw err;
    }
  };

  // Handle agentic tool config clear
  const handleAgenticConfigClear = (tool: AgenticToolName) => {
    const clearedValues = getClearedFormValues(tool);
    agenticFormByTool[tool].setFieldsValue(clearedValues);
    setAgenticConfigDraftByTool((prev) => ({ ...prev, [tool]: clearedValues }));
    markAgenticConfigDirty(tool);
  };

  // Resolve a tool's effective credential source, auth method, and connection
  // status. Shared by the sidebar status dot and the provider panel so both
  // read from one place instead of drifting.
  const resolveProvider = useCallback(
    (tool: AgenticToolName) => {
      const canonicalTool = (
        tool === 'claude-code-cli' ? 'claude-code' : tool
      ) as TenantAgenticToolName;
      const credentialToolName: AgenticToolName = tool === 'claude-code-cli' ? 'claude-code' : tool;
      // Field set is owned by ApiKeyFields' `TOOL_FIELD_CONFIGS`. Claude and Codex
      // expose an explicit method so dormant credentials are never selected by accident.
      const allToolFields = TOOL_FIELD_CONFIGS[tool] ?? [];
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
        toolFields.some(({ field }) => fieldStatus[field] && !String(field).endsWith('_BASE_URL'));
      const workspaceConfigured = Object.entries(tenantSettings?.connection ?? {}).some(
        ([field, status]) => status?.configured && !field.endsWith('_BASE_URL')
      );
      const managedByWorkspace = resolutionPolicy === 'tenant_required';
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
      // An unresolvable credential reads as "not connected" even under a
      // workspace-managed policy — otherwise a tenant_required tool with no
      // workspace credential would show a "managed" dot while its own panel
      // says the effective source is Unavailable.
      const status: ProviderStatus =
        effectiveSource === 'Unavailable'
          ? 'not_connected'
          : managedByWorkspace
            ? 'workspace_managed'
            : 'connected';
      return {
        canonicalTool,
        credentialToolName,
        allToolFields,
        fieldStatus,
        authMethod,
        toolFields,
        resolutionPolicy,
        personalConfigured,
        managedByWorkspace,
        effectiveSource,
        status,
      };
    },
    [agenticAuthMethods, agenticToolStatus, tenantToolSettings]
  );

  const statusDotColor = useMemo<Record<ProviderStatus, string>>(
    () => ({
      connected: token.colorSuccess,
      not_connected: token.colorTextQuaternary,
      workspace_managed: token.colorPrimary,
    }),
    [token.colorSuccess, token.colorTextQuaternary, token.colorPrimary]
  );

  // Scoped theme for the modal nav: a muted selected-pill so the rail reads like
  // the rest of the app (v6's default selected bg is too bright here).
  const scopedTheme = useMemo(
    () => ({
      components: {
        Menu: {
          itemSelectedBg: token.colorFillTertiary,
          itemSelectedColor: token.colorPrimary,
        },
      },
    }),
    [token.colorFillTertiary, token.colorPrimary]
  );

  // Sidebar navigation model. Kept as plain data so the same structure feeds
  // both the AntD menu and the search filter.
  const navGroups = useMemo(() => {
    const groups: Array<{
      key: string;
      label: string;
      children: Array<{
        key: string;
        title: string;
        icon?: React.ReactNode;
        status?: ProviderStatus;
      }>;
    }> = [
      {
        key: 'grp-account',
        label: 'Account',
        children: [
          { key: 'profile', title: 'Profile', icon: <UserOutlined /> },
          { key: 'preferences', title: 'Preferences', icon: <BellOutlined /> },
          { key: 'security', title: 'Security', icon: <LockOutlined /> },
          // Personal API tokens are scoped to the signed-in caller, so they are
          // meaningless (and misleading) when an admin edits another user.
          ...(isEditingOther
            ? []
            : [{ key: 'tokens', title: 'API Tokens', icon: <KeyOutlined /> }]),
        ],
      },
      {
        key: 'grp-providers',
        label: 'AI Providers',
        children: visibleAgenticToolTabs.map((tool) => ({
          key: providerKeyFor(tool),
          title: AGENTIC_TOOL_DISPLAY_NAMES[tool],
          status: resolveProvider(tool).status,
        })),
      },
      {
        key: 'grp-environment',
        label: 'Environment',
        children: [
          { key: 'env-vars', title: 'Environment Variables', icon: <ThunderboltOutlined /> },
        ],
      },
    ];

    if (isAdmin) {
      groups.push({
        key: 'grp-admin',
        label: 'Admin',
        children: [
          { key: 'access', title: 'Groups & Access', icon: <SafetyCertificateOutlined /> },
        ],
      });
    }
    return groups;
  }, [visibleAgenticToolTabs, isAdmin, isEditingOther, resolveProvider]);

  const menuItems: MenuProps['items'] = useMemo(
    () =>
      navGroups.map((group) => ({
        key: group.key,
        type: 'group' as const,
        label: group.label,
        children: group.children.map((child) => ({
          key: child.key,
          icon: child.icon,
          label: child.status ? (
            <Space size={8}>
              <Badge color={statusDotColor[child.status]} />
              <span>{child.title}</span>
              <span style={SR_ONLY_STYLE}>{PROVIDER_STATUS_LABEL[child.status]}</span>
            </Space>
          ) : (
            child.title
          ),
        })),
      })),
    [navGroups, statusDotColor]
  );

  const activeInNav = navGroups.some((group) =>
    group.children.some((child) => child.key === activeKey)
  );

  // Global search index across every panel's contents (not just nav names).
  const settingsIndex = useMemo<SettingIndexEntry[]>(() => {
    const entries: SettingIndexEntry[] = [
      { label: 'Profile', keywords: 'account identity', panelKey: 'profile' },
      { label: 'Name', panelKey: 'profile' },
      { label: 'Emoji', keywords: 'avatar icon', panelKey: 'profile' },
      { label: 'Email', panelKey: 'profile' },
      { label: 'Use Slack avatar', keywords: 'profile image picture', panelKey: 'profile' },
      { label: 'Role', keywords: 'permission admin member viewer', panelKey: 'profile' },
      { label: 'Preferences', keywords: 'audio interface sound', panelKey: 'preferences' },
      { label: 'Enable chimes', keywords: 'sound audio notification', panelKey: 'preferences' },
      { label: 'Volume', keywords: 'sound audio loudness', panelKey: 'preferences' },
      { label: 'Chime sound', keywords: 'audio notification tone', panelKey: 'preferences' },
      {
        label: 'Minimum task duration',
        keywords: 'chime audio seconds threshold',
        panelKey: 'preferences',
      },
      {
        label: 'Live event stream',
        keywords: 'websocket debug beta navbar',
        panelKey: 'preferences',
      },
      { label: 'Security', keywords: 'account', panelKey: 'security' },
      { label: 'Password', keywords: 'credentials security', panelKey: 'security' },
      { label: 'Unix username', keywords: 'impersonation os process user', panelKey: 'security' },
      { label: 'Environment variables', keywords: 'env vars secrets', panelKey: 'env-vars' },
    ];
    if (isSelf && onRestartOnboarding) {
      entries.push({
        label: 'Restart onboarding',
        keywords: 'wizard setup teammate',
        panelKey: 'profile',
      });
    }
    if (!isEditingOther) {
      entries.push(
        { label: 'API tokens', keywords: 'agor api key ci pipeline', panelKey: 'tokens' },
        { label: 'Create API token', keywords: 'new key agor', panelKey: 'tokens' }
      );
    }
    if (isAdmin) {
      entries.push(
        { label: 'Groups & access', keywords: 'admin permissions', panelKey: 'access' },
        { label: 'Groups', keywords: 'membership branch permissions', panelKey: 'access' }
      );
    }
    if (isAdmin && isEditingOther) {
      entries.push({
        label: 'Force password change',
        keywords: 'security reset next login',
        panelKey: 'access',
      });
    }
    for (const tool of visibleAgenticToolTabs) {
      const name = AGENTIC_TOOL_DISPLAY_NAMES[tool];
      const providerKey = providerKeyFor(tool);
      entries.push(
        { label: name, keywords: `${tool} provider ai model`, panelKey: providerKey },
        {
          label: 'Authentication',
          keywords: `${name} ${tool} api key credentials sign in oauth`,
          panelKey: providerKey,
        },
        {
          label: 'Session defaults',
          keywords: `${name} ${tool} permission mode model mcp effort`,
          panelKey: providerKey,
        }
      );
    }
    return entries;
  }, [visibleAgenticToolTabs, isAdmin, isEditingOther, isSelf, onRestartOnboarding]);

  const searchActive = search.trim().length > 0;

  // Relevance ranking, most significant first: (1) a matched page/tab name;
  // (2) a setting that lives in a matched tab (tab-membership outranks how the
  // setting matched, so a keyword-only hit in the matched tab still beats a
  // label hit elsewhere); (3) a label match over a keyword/alias-only match;
  // (4) a prefix over a mid-substring; (5) index for a stable, deterministic tie.
  const searchResults = useMemo(() => {
    if (!searchActive) return [];
    const query = search.trim().toLowerCase();
    const matched = settingsIndex
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) =>
        matchesSettingsSearch(entry, search, [(e) => e.label, (e) => e.keywords])
      );
    const matchedTabKeys = new Set(
      matched.filter(({ entry }) => isPageMatch(entry, query)).map(({ entry }) => entry.panelKey)
    );
    return matched
      .map(({ entry, index }) => {
        const labelLc = entry.label.toLowerCase();
        return {
          entry,
          index,
          t1: isPageMatch(entry, query) ? 0 : 1,
          t2: matchedTabKeys.has(entry.panelKey) ? 0 : 1,
          t3: labelLc.includes(query) ? 0 : 1,
          t4: labelLc.startsWith(query) ? 0 : 1,
        };
      })
      .sort((a, b) => a.t1 - b.t1 || a.t2 - b.t2 || a.t3 - b.t3 || a.t4 - b.t4 || a.index - b.index)
      .map(({ entry }) => entry);
  }, [settingsIndex, search, searchActive]);

  const searchMenuItems: MenuProps['items'] = useMemo(() => {
    const query = search.trim().toLowerCase();
    // Page hits are ranked first; drop a divider before the first non-page hit
    // only when both kinds are present (no dangling divider).
    const showDivider =
      searchResults.some((entry) => isPageMatch(entry, query)) &&
      searchResults.some((entry) => !isPageMatch(entry, query));
    const items: NonNullable<MenuProps['items']> = [];
    let dividerPlaced = false;
    searchResults.forEach((entry, index) => {
      if (showDivider && !dividerPlaced && !isPageMatch(entry, query)) {
        items.push({ type: 'divider' });
        dividerPlaced = true;
      }
      const panelTitle = panelTitleForKey(entry.panelKey);
      items.push({
        key: String(index),
        label: (
          <Space size={6}>
            <span>
              <HighlightMatch text={entry.label} query={search} />
            </span>
            {panelTitle !== entry.label && (
              <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                · {panelTitle}
              </Typography.Text>
            )}
          </Space>
        ),
      });
    });
    return items;
  }, [searchResults, search, token.fontSizeSM]);

  // A search that hides the active panel from the nav keeps the panel rendering
  // (renderContent reads activeKey, not the search) so in-progress edits are
  // never dropped; clicking a hit navigates and clears the query.
  const handleSearchResultClick = (key: string) => {
    const entry = searchResults[Number(key)];
    if (!entry) return;
    setActiveKey(entry.panelKey);
    setSearch('');
  };

  const isInlineSavePanel =
    activeKey === 'env-vars' ||
    activeKey === 'tokens' ||
    (!!activeTool && providerSubtab === 'auth');

  // Unified footer action. Batch panels commit their edits and close; inline
  // panels (env vars, tokens, provider auth) have already persisted per row /
  // per field, so "Done" only flushes any dirty session-defaults left over
  // from another provider before closing.
  const handleModalSave = async () => {
    if (!user || savingModal) return;
    setSavingModal(true);
    try {
      if (activeTool) {
        if (providerSubtab === 'defaults') {
          await handleAgenticConfigSave(activeTool);
        } else {
          await saveDirtyAgenticConfigs();
        }
        handleClose();
        return;
      }

      switch (activeKey) {
        case 'profile':
          if (!(await handleProfileSave())) return;
          break;
        case 'security':
          if (!(await handleSecuritySave())) return;
          break;
        case 'preferences':
          if (!(await handlePreferencesSave())) return;
          break;
        case 'access':
          if (!(await handleAccessSave())) return;
          break;
        // env-vars and tokens persist inline; nothing to commit here.
      }

      await saveDirtyAgenticConfigs();
      handleClose();
    } finally {
      setSavingModal(false);
    }
  };

  const renderProfilePanel = () => (
    <>
      <PanelHeader title="Profile" />
      <Form form={form} layout="vertical">
        <FieldRow label="Name">
          <Space.Compact style={{ width: '100%' }}>
            <Form.Item name="emoji" noStyle>
              <FormEmojiPickerInput form={form} fieldName="emoji" defaultEmoji="👤" />
            </Form.Item>
            <Form.Item name="name" noStyle>
              <Input placeholder="John Doe" />
            </Form.Item>
          </Space.Compact>
        </FieldRow>

        <FieldRow
          label="Email"
          required
          name="email"
          rules={[
            { required: true, message: 'Please enter an email' },
            { type: 'email', message: 'Please enter a valid email' },
          ]}
        >
          <Input placeholder="user@example.com" />
        </FieldRow>

        <FieldRow
          label="Use Slack avatar when available"
          name="useSlackAvatar"
          valuePropName="checked"
          tooltip="Shows your Slack-synced profile image instead of the emoji tile above. Turns off automatically if Slack sync is removed."
        >
          <Switch />
        </FieldRow>

        <FieldRow
          label="Role"
          required
          name="role"
          rules={[{ required: true, message: 'Please select a role' }]}
          help={isAdmin ? undefined : 'Maintained by administrators'}
        >
          <Select
            disabled={!isAdmin}
            style={{ maxWidth: 320 }}
            options={ROLE_OPTIONS.map((opt) => ({
              value: opt.value,
              label: opt.label,
              description: opt.description,
            }))}
            optionRender={(opt) => (
              <div>
                <div>{opt.data.label}</div>
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  {opt.data.description}
                </Typography.Text>
              </div>
            )}
          />
        </FieldRow>
      </Form>

      {onRestartOnboarding && isSelf && (
        <>
          <SectionDivider label="Onboarding" />
          <Typography.Paragraph type="secondary" style={{ maxWidth: 480 }}>
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
        </>
      )}
    </>
  );

  const renderSecurityPanel = () => (
    <>
      <PanelHeader title="Security" />
      <Form form={form} layout="vertical">
        <FieldRow label="Password" name="password" help="Leave blank to keep current password">
          <Input.Password placeholder="••••••••" />
        </FieldRow>

        <FieldRow
          label="Unix username"
          name="unix_username"
          help={
            isAdmin
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
          <Input placeholder="johnsmith" maxLength={32} disabled={!isAdmin} />
        </FieldRow>
      </Form>
    </>
  );

  const renderPreferencesPanel = () => (
    <>
      <PanelHeader title="Preferences" />
      <AudioSettingsTab user={user} form={audioForm} />
      <SectionDivider label="Interface" />
      <Form form={form} layout="vertical">
        <FieldRow
          label="Live event stream"
          badge={
            <Tag color={token.colorPrimary} style={{ fontSize: token.fontSizeSM }}>
              BETA
            </Tag>
          }
          name="eventStreamEnabled"
          valuePropName="checked"
          tooltip="Adds an icon to the navbar to inspect live WebSocket events for debugging."
        >
          <Switch />
        </FieldRow>
      </Form>
    </>
  );

  const renderEnvVarsPanel = () => (
    <>
      <PanelHeader title="Environment variables" />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Environment variables are encrypted at rest and available to all sessions for this user.
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message={
          <span>
            Looking for SDK credentials? API keys and per-tool config live under{' '}
            <strong>AI Providers</strong> in the sidebar, scoped so credentials never leak across
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

  const renderAccessPanel = () => (
    <>
      <PanelHeader title="Groups & access" />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Add or remove this user from admin-managed groups.
      </Typography.Paragraph>
      <Form form={form} layout="vertical">
        <FieldRow
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
        </FieldRow>

        {isEditingOther && (
          <>
            <SectionDivider label="Danger zone" />
            <Form.Item
              name="must_change_password"
              valuePropName="checked"
              style={{ marginBottom: 0 }}
            >
              <Checkbox>Force password change on next login</Checkbox>
            </Form.Item>
          </>
        )}
      </Form>
    </>
  );

  const renderProviderPanel = (tool: AgenticToolName) => {
    const currentForm = agenticFormByTool[tool];
    const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool];
    const {
      canonicalTool,
      credentialToolName,
      allToolFields,
      fieldStatus,
      authMethod,
      toolFields,
      resolutionPolicy,
      personalConfigured,
      managedByWorkspace,
      effectiveSource,
      status,
    } = resolveProvider(tool);

    const savingForTool: Partial<Record<AgenticToolConfigField, boolean>> = Object.fromEntries(
      toolFields.map((c) => [c.field, !!savingToolField[`${credentialToolName}.${c.field}`]])
    );

    const statusTag =
      status === 'connected' ? (
        <Tag color="success" icon={<CheckCircleFilled />}>
          Connected
        </Tag>
      ) : status === 'workspace_managed' ? (
        <Tag color="processing">Managed by workspace</Tag>
      ) : (
        <Tag icon={<MinusCircleOutlined />}>Not connected</Tag>
      );

    const header = (
      <PanelHeader
        title={displayName}
        icon={<ToolIcon tool={tool} size={32} />}
        extra={statusTag}
      />
    );

    const defaultsPane = (
      <>
        <Typography.Paragraph type="secondary" style={{ marginBottom: 20 }}>
          Prepopulates session creation forms with these defaults.
        </Typography.Paragraph>
        <Form
          key={tool}
          form={currentForm}
          layout="vertical"
          onValuesChange={(_, allValues) => {
            setAgenticConfigDraftByTool((prev) => ({ ...prev, [tool]: allValues }));
            markAgenticConfigDirty(tool);
          }}
        >
          <UserAgenticDefaultEditor tool={tool} client={client} isAdmin={isAdmin} />
          <SessionMcpServersField mcpServerById={mcpServerById} showHelpText={false} />
        </Form>
        <Divider style={{ margin: '20px 0' }} />
        <Button danger type="text" onClick={() => handleAgenticConfigClear(tool)}>
          Clear defaults
        </Button>
      </>
    );

    // Tools with no auth/config fields (e.g. OpenCode) skip the tab strip entirely.
    if (allToolFields.length === 0) {
      return (
        <>
          {header}
          {defaultsPane}
        </>
      );
    }

    const personalPolicyDescription =
      resolutionPolicy === 'user_required'
        ? 'Your personal configuration is required. Workspace credentials will not be used.'
        : resolutionPolicy === 'user_preferred'
          ? 'Your personal configuration is used first, with workspace configuration as fallback.'
          : 'Workspace configuration is used first. Your personal configuration is retained as fallback.';

    // Actionable states surface as a compact Alert above the fields; the
    // steady-state "effective source" reads as a caption below them.
    const aboveNote = managedByWorkspace ? (
      <Alert
        type="info"
        showIcon
        message="Authentication is managed by this workspace — your personal configuration is never used while this policy is active."
        style={{ marginBottom: 16 }}
      />
    ) : effectiveSource === 'Unavailable' ? (
      <Alert
        type="warning"
        showIcon
        message="No credentials configured yet"
        style={{ marginBottom: 16 }}
      />
    ) : null;

    const effectiveSourceCaption =
      !managedByWorkspace && effectiveSource !== 'Unavailable' ? (
        <Typography.Paragraph
          type="secondary"
          style={{ fontSize: token.fontSizeSM, marginTop: 20, marginBottom: 0 }}
        >
          Effective source: {effectiveSource}. {personalPolicyDescription}
        </Typography.Paragraph>
      ) : null;

    const authPane = (
      <>
        {aboveNote}
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
        ) : canonicalTool === 'codex' ? (
          <CodexAuthSettings
            client={client}
            authMethod={authMethod ?? 'api_key'}
            allowChatgptLogin={isSelf}
            apiKeyFields={allToolFields}
            fieldStatus={fieldStatus}
            onSaveField={(field, value) => handleToolFieldSave(credentialToolName, field, value)}
            onClearField={(field) => handleToolFieldClear(credentialToolName, field)}
            savingFields={Object.fromEntries(
              allToolFields.map((c) => [
                c.field,
                !!savingToolField[`${credentialToolName}.${c.field}`],
              ])
            )}
            publicValues={
              user?.agentic_tools_public_values?.[credentialToolName] as
                | Partial<Record<AgenticToolConfigField, string>>
                | undefined
            }
          />
        ) : (
          <Form component={false} layout="vertical">
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Personal credentials are encrypted at rest and injected only into the agent runtime.
            </Typography.Paragraph>
            {canonicalTool === 'claude-code' && (
              <FieldRow
                label="Sign-in method"
                tooltip="Choose one — Agor uses whichever is selected, the other is ignored."
              >
                <Radio.Group
                  buttonStyle="solid"
                  value={authMethod}
                  onChange={(event) =>
                    void handleAuthMethodChange(canonicalTool, event.target.value)
                  }
                >
                  <Radio.Button value="subscription">Claude subscription</Radio.Button>
                  <Radio.Button value="api_key">API key</Radio.Button>
                </Radio.Group>
              </FieldRow>
            )}
            <ApiKeyFields
              tool={tool}
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
          </Form>
        )}
        {effectiveSourceCaption}
      </>
    );

    return (
      <>
        {header}
        <Tabs
          activeKey={providerSubtab}
          onChange={(key) => setProviderSubtab(key as ProviderSubtab)}
          items={[
            { key: 'auth', label: 'Authentication', children: authPane },
            // Force-render so the Session Defaults <Form> is mounted (and
            // connected) even while Authentication is the visible sub-tab —
            // otherwise the hydration effect calls setFieldsValue on an
            // unconnected form and Ant logs a "not connected" warning.
            {
              key: 'defaults',
              label: 'Session defaults',
              children: defaultsPane,
              forceRender: true,
            },
          ]}
        />
      </>
    );
  };

  const renderContent = () => {
    if (activeTool) return renderProviderPanel(activeTool);

    switch (activeKey) {
      case 'profile':
        return renderProfilePanel();
      case 'security':
        return renderSecurityPanel();
      case 'preferences':
        return renderPreferencesPanel();
      case 'env-vars':
        return renderEnvVarsPanel();
      case 'tokens':
        return (
          <>
            <PanelHeader title="API tokens" />
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Agor API tokens allow you to authenticate with the Agor API from scripts, CI
              pipelines, and external tools. Tokens have the same permissions as your user account.
            </Typography.Paragraph>
            <PersonalApiKeysTab client={client} />
          </>
        );
      case 'access':
        return renderAccessPanel();
      default:
        return renderProfilePanel();
    }
  };

  const modalTitle = isEditingOther ? (
    <Space size={8}>
      <UserIdentityAvatar user={user} size={24} fontSize="14px" />
      <span>Editing {user?.name || user?.email}</span>
    </Space>
  ) : (
    'Settings'
  );

  const footer = isInlineSavePanel
    ? [
        <Typography.Text
          key="hint"
          type="secondary"
          style={{ fontSize: token.fontSizeSM, marginRight: token.marginSM }}
        >
          Changes save automatically
        </Typography.Text>,
        <Button key="done" type="primary" onClick={handleModalSave} loading={savingModal}>
          Done
        </Button>,
      ]
    : [
        <Button key="close" onClick={handleClose} disabled={savingModal}>
          Close
        </Button>,
        <Button key="save" type="primary" onClick={handleModalSave} loading={savingModal}>
          Save
        </Button>,
      ];

  return (
    <Modal
      title={modalTitle}
      open={open}
      onCancel={handleClose}
      footer={footer}
      closable
      width="min(1050px, calc(100vw - 32px))"
      styles={{
        body: {
          padding: 0,
          height: 'calc(100vh - 280px)',
          maxHeight: 650,
        },
      }}
    >
      {/* Keep inactive form instances connected to Ant Form. Without these
          lightweight hidden connectors, calling form methods while switching
          panels can produce noisy "useForm is not connected" console warnings. */}
      <div hidden aria-hidden="true">
        {!MAIN_FORM_KEYS.includes(activeKey as (typeof MAIN_FORM_KEYS)[number]) && (
          <Form component={false} form={form} />
        )}
        {activeKey !== 'preferences' && <Form component={false} form={audioForm} />}
        {visibleAgenticToolTabs.map((tool) =>
          activeTool === tool ? null : (
            <Form key={tool} component={false} form={agenticFormByTool[tool]} />
          )
        )}
      </div>
      <ConfigProvider theme={scopedTheme}>
        <Layout style={{ height: '100%', background: token.colorBgContainer }}>
          <Sider
            width={220}
            style={{
              background: token.colorBgElevated,
              borderRight: `1px solid ${token.colorBorderSecondary}`,
              overflow: 'auto',
              padding: '20px 0',
            }}
          >
            <div style={{ padding: `0 ${token.marginXXS}px ${token.marginSM}px` }}>
              <Input
                allowClear
                placeholder="Search settings"
                prefix={<SearchOutlined style={{ color: token.colorTextTertiary }} />}
                value={search}
                onChange={(event) => setSearch(event.target.value)}
              />
            </div>
            {searchActive ? (
              searchResults.length === 0 ? (
                <div style={{ padding: '8px 16px' }}>
                  <Typography.Text type="secondary">No settings match “{search}”</Typography.Text>
                </div>
              ) : (
                <Menu
                  mode="inline"
                  selectedKeys={[]}
                  onClick={({ key }) => handleSearchResultClick(key)}
                  items={searchMenuItems}
                  style={{ borderInlineEnd: 'none', background: 'transparent' }}
                />
              )
            ) : (
              <Menu
                mode="inline"
                selectedKeys={activeInNav ? [activeKey] : []}
                onClick={({ key }) => setActiveKey(key)}
                items={menuItems}
                style={{ borderInlineEnd: 'none', background: 'transparent' }}
              />
            )}
          </Sider>
          <Content style={{ padding: '28px 32px', overflow: 'auto' }}>{renderContent()}</Content>
        </Layout>
      </ConfigProvider>
    </Modal>
  );
};
