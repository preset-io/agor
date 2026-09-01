import { AGENTIC_TOOL_CAPABILITIES, AGENTIC_TOOL_DISPLAY_NAMES } from '@agor/agentic-tools';
import { type AgenticToolReadiness, getAgenticToolUIIntegration } from '@agor/agentic-tools/ui';
import { EXECUTION_HOME_KEY_PATTERN } from '@agor/core/types';
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
  ArrowLeftOutlined,
  BellOutlined,
  CheckCircleFilled,
  CloseOutlined,
  CloudUploadOutlined,
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
import { copyToClipboard } from '../../utils/clipboard';
import { searchableSelectProps, toGroupSelectOption } from '../../utils/selectSearch';
import { getSettingsSearchTokens, matchesSettingsSearchTokens } from '../../utils/settingsSearch';
import {
  buildConfigFromFormValues,
  getClearedFormValues,
  getFormValuesFromConfig,
  modelLabelForTool,
} from '../AgenticToolConfigForm';
import { ApiKeyFields, type FieldStatus, TOOL_FIELD_CONFIGS } from '../ApiKeyFields';
import { CodexAuthSettings } from '../CodexAuth';
import { EnvVarEditor } from '../EnvVarEditor';
import { HighlightMatch } from '../HighlightMatch';
import { SessionMcpServersField } from '../MCPServerSelect';
import { ToolIcon } from '../ToolIcon';
import { UserIdentityAvatar } from '../UserIdentityAvatar';
import { AudioSettingsTab } from './AudioSettingsTab';
import { syncGroupsForUser } from './groupMembershipSync';
import { PersonalApiKeysTab } from './PersonalApiKeysTab';
import { FieldRow, PanelHeader, SectionDivider } from './panelPrimitives';
import { UploadsTab } from './UploadsTab';
import { UserAgenticDefaultEditor } from './UserAgenticDefaultEditor';

const { Sider, Content } = Layout;

const AGENTIC_TOOL_TABS = [
  'claude-code',
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

type ProviderSubtab = 'auth' | 'defaults';

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

function AgenticToolReadinessSlot({
  tool,
  client,
  canLoadReadiness,
  fallback,
  children,
}: {
  tool: AgenticToolName;
  client: AgorClient | null;
  canLoadReadiness: boolean;
  fallback: AgenticToolReadiness;
  children: (status: AgenticToolReadiness) => React.ReactNode;
}) {
  const Readiness = getAgenticToolUIIntegration(tool)?.Readiness;
  return Readiness ? (
    <Readiness client={client} canLoadReadiness={canLoadReadiness}>
      {children}
    </Readiness>
  ) : (
    children(fallback)
  );
}

function agenticToolReadinessTag(status: AgenticToolReadiness): React.ReactNode {
  if (status.tone === 'positive') {
    return (
      <Tag color="success" icon={<CheckCircleFilled />}>
        {status.label}
      </Tag>
    );
  }
  if (status.tone === 'info') return <Tag color="processing">{status.label}</Tag>;
  return <Tag icon={<MinusCircleOutlined />}>{status.label}</Tag>;
}

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

// Deep links (banners, saved URLs) may still carry pre-redesign tab ids. Map
// them onto the current panel keys so a stale link lands on the right panel
// instead of silently falling through to Profile.
const LEGACY_TAB_ALIASES: Record<string, string> = {
  general: 'profile',
  audio: 'preferences',
  groups: 'access',
  'personal-api-keys': 'tokens',
};

const normalizeInitialKey = (tab?: string): string => {
  if (!tab) return 'profile';
  if (isAgenticToolTab(tab)) return providerKeyFor(tab);
  return LEGACY_TAB_ALIASES[tab] ?? tab;
};

// Flat index powering the modal's global search: every setting maps to the
// panel that hosts it. Provider rows are appended per enabled tool at runtime.
// NOTE: when adding a new setting to any panel, add an entry here (with search
// keywords) so it stays findable.
interface SettingIndexEntry {
  label: string;
  keywords?: string;
  panelKey: string;
  /** 'page' = a nav tab/panel itself; 'setting' = a control within a panel. */
  kind: 'page' | 'setting';
  /** For provider settings, the sub-tab the hit should open (auth vs defaults). */
  subtab?: ProviderSubtab;
}

// Single source of truth for each static (non-provider) panel: the nav label,
// its icon, the PanelHeader title, and search-page keywords all read from here
// so casing/keywords never drift across the three call sites.
const PANEL_META: Record<string, { title: string; icon: React.ReactNode; keywords: string }> = {
  profile: { title: 'Profile', icon: <UserOutlined />, keywords: 'account identity name email' },
  preferences: {
    title: 'Preferences',
    icon: <BellOutlined />,
    keywords: 'audio sound interface chime',
  },
  security: { title: 'Security', icon: <LockOutlined />, keywords: 'account password credentials' },
  tokens: { title: 'API tokens', icon: <KeyOutlined />, keywords: 'api token key ci pipeline' },
  uploads: {
    title: 'Uploads',
    icon: <CloudUploadOutlined />,
    keywords: 'files attachments images downloads',
  },
  'env-vars': {
    title: 'Environment variables',
    icon: <ThunderboltOutlined />,
    keywords: 'env vars secrets',
  },
  access: {
    title: 'Groups & access',
    icon: <SafetyCertificateOutlined />,
    keywords: 'admin groups permissions',
  },
};

const panelTitleForKey = (key: string): string =>
  key.startsWith(PROVIDER_KEY_PREFIX)
    ? AGENTIC_TOOL_DISPLAY_NAMES[toolFromProviderKey(key)]
    : (PANEL_META[key]?.title ?? key);

// A "page" hit: a page/tab entry whose visible name matched every query token.
// A page found only via a keyword alias is NOT treated as a page match.
const isPageMatch = (entry: SettingIndexEntry, tokens: string[]): boolean => {
  if (entry.kind !== 'page') return false;
  const labelLc = entry.label.toLowerCase();
  return tokens.every((token) => labelLc.includes(token));
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
  /**
   * Render inline (no outer Modal) as a drill-in inside the Workspace Settings
   * shell, with a "Back" affordance instead of a modal close. Default false →
   * the standalone Modal used elsewhere is unchanged.
   */
  embedded?: boolean;
  /** Label for the embedded back button (e.g. "Back to Users"). */
  backLabel?: string;
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
  embedded = false,
  backLabel = 'Back',
}) => {
  const { token } = theme.useToken();

  // Entity maps are read from the store rather than drilled through props so
  // the App shell doesn't have to forward them into every modal.
  const mcpServerById = useAgorStore(selectMcpServerById);
  const tenantToolSettings = useAgorStore((state) => state.agenticToolSettingsByName);
  // Tenant tool settings hydrate in the background; until they do, an empty map
  // reports every tool as enabled. Gate provider content on this flag so a
  // disabled-provider deep link can't fail open during the cold-load window.
  const tenantToolSettingsHydrated = useAgorStore((state) => state.agenticToolSettingsHydrated);
  const visibleAgenticToolTabs = useMemo(
    () =>
      AGENTIC_TOOL_TABS.filter(
        (tool) => tenantToolSettings.get(tool as TenantAgenticToolName)?.enabled !== false
      ),
    [tenantToolSettings]
  );

  const [form] = Form.useForm();
  const [rawActiveKey, setActiveKey] = useState<string>(() => normalizeInitialKey(initialTab));
  const [search, setSearch] = useState('');
  const [providerSubtab, setProviderSubtab] = useState<ProviderSubtab>('auth');
  const [savingModal, setSavingModal] = useState(false);
  const initializedUserIdRef = useRef<string | null>(null);
  // A search hit for a provider setting requests the sub-tab it lives on; the
  // provider-subtab reset effect consumes this so the hit lands on the right
  // sub-tab instead of the default Authentication view. Scoped to the provider
  // key so a hit for the ALREADY-active provider can't leak its sub-tab onto
  // the next provider opened.
  const pendingProviderSubtabRef = useRef<{ panelKey: string; subtab: ProviderSubtab } | null>(
    null
  );
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const isEditingOther = !!user && !!currentUser && user.user_id !== currentUser.user_id;
  const isSelf = !!user && !!currentUser && user.user_id === currentUser.user_id;

  // Authorize the active panel SYNCHRONOUSLY during render (never correct it in
  // an effect): a stale/unauthorized key must resolve to Profile before any
  // content mounts, so the caller-scoped tokens/uploads panels can't start
  // loading the CALLER's data under the edited user's identity, and a
  // tenant-disabled provider deep link can't render its credential controls.
  // Mirrors the permission gating that builds `navGroups`.
  const activeKey = ((): string => {
    if (rawActiveKey.startsWith(PROVIDER_KEY_PREFIX)) {
      // FAIL CLOSED until availability is known: an unhydrated store reports
      // every tool as enabled, so a disabled-provider deep link would briefly
      // mount its credential/default controls. Resolve to Profile until the
      // settings load, then apply the enabled filter.
      if (!tenantToolSettingsHydrated) return 'profile';
      return visibleAgenticToolTabs.includes(toolFromProviderKey(rawActiveKey))
        ? rawActiveKey
        : 'profile';
    }
    if ((rawActiveKey === 'tokens' || rawActiveKey === 'uploads') && isEditingOther)
      return 'profile';
    if (rawActiveKey === 'access' && !isAdmin) return 'profile';
    return rawActiveKey;
  })();

  // Separate forms for each agentic tool tab
  const [claudeForm] = Form.useForm();
  const [codexForm] = Form.useForm();
  const [geminiForm] = Form.useForm();
  const [opencodeForm] = Form.useForm();
  const [copilotForm] = Form.useForm();
  const [cursorForm] = Form.useForm();
  const [audioForm] = Form.useForm();

  const agenticFormByTool = useMemo<Record<AgenticToolName, ReturnType<typeof Form.useForm>[0]>>(
    () => ({
      'claude-code': claudeForm,
      codex: codexForm,
      gemini: geminiForm,
      opencode: opencodeForm,
      copilot: copilotForm,
      cursor: cursorForm,
    }),
    [claudeForm, codexForm, copilotForm, cursorForm, geminiForm, opencodeForm]
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
  // `default_mcp_server_ids` is USER-level, but each provider form carries its
  // own `mcpServerIds` field seeded from that shared value. Track which tool most
  // recently edited it so Save reads the intended list instead of whichever tool
  // happened to sort first in the dirty set (which dropped the newer edit).
  const [mcpEditSourceTool, setMcpEditSourceTool] = useState<AgenticToolName | null>(null);

  // The shared `form` (+ audioForm) backs Profile/Security/Preferences/Access.
  // Track which of those panels the user has edited so Save flushes ALL of them
  // — otherwise editing one panel and saving from another would drop the edit.
  const [dirtyMainPanels, setDirtyMainPanels] = useState<Set<string>>(() => new Set());
  const markMainPanelDirty = useCallback((panel: string) => {
    setDirtyMainPanels((prev) => (prev.has(panel) ? prev : new Set(prev).add(panel)));
  }, []);

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
      setMcpEditSourceTool(null);
      setDirtyMainPanels(new Set());
      setSearch('');

      form.setFieldsValue({
        email: userData.email,
        name: userData.name,
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
  // Tools with neither host nor package-owned auth settings only have Session
  // Defaults, so they land there directly.
  useEffect(() => {
    if (!activeTool) return;
    // A pending sub-tab from a search hit wins over the default, but only for
    // the provider it targeted; consume it once regardless so it can't leak.
    const pending = pendingProviderSubtabRef.current;
    pendingProviderSubtabRef.current = null;
    const requested = pending?.panelKey === providerKeyFor(activeTool) ? pending.subtab : undefined;
    const hasAuth =
      (TOOL_FIELD_CONFIGS[activeTool] ?? []).length > 0 ||
      !!getAgenticToolUIIntegration(activeTool)?.ProviderSettings;
    setProviderSubtab(requested ?? (hasAuth ? 'auth' : 'defaults'));
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

    // Seed the audio form from persisted values only while it is still
    // pristine. Once the user has edited Preferences, navigating away and back
    // must preserve the in-progress draft rather than reverting to the saved
    // values — the same draft-preservation contract as the agentic config above
    // (and the #1769 revert). `dirtyMainPanels` is intentionally read via the
    // fresh closure, not a dependency, so it never re-triggers hydration.
    if (activeKey === 'preferences' && !dirtyMainPanels.has('preferences')) {
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
    setMcpEditSourceTool(null);
    setDirtyMainPanels(new Set());
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

    // `default_mcp_server_ids` is user-level, so read it from the tool that most
    // recently edited it (falling back to the first saved tool). Reading from
    // `tools[0]` alone dropped the newer edit when two tools were dirty.
    const mcpSourceTool =
      mcpEditSourceTool && tools.includes(mcpEditSourceTool) ? mcpEditSourceTool : tools[0];
    const defaultMcpServerIds = mcpSourceTool
      ? ((agenticConfigDraftByTool[mcpSourceTool]?.mcpServerIds ??
          agenticFormByTool[mcpSourceTool].getFieldValue('mcpServerIds')) as string[] | undefined)
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
    if (mcpEditSourceTool && tools.includes(mcpEditSourceTool)) setMcpEditSourceTool(null);
  };

  const saveDirtyAgenticConfigs = async () => {
    await saveAgenticConfigs(getAgenticConfigToolsToSave());
  };

  // Profile panel: identity fields + Slack-avatar preference.
  // Commit every edited main-form panel in a single patch. Building one
  // `preferences` object here (rather than one patch per panel) is what keeps a
  // Profile edit and a Preferences edit from clobbering each other's keys when
  // both are flushed against the same not-yet-refreshed `user` prop.
  const commitMainPanels = async (panels: Set<string>): Promise<boolean> => {
    if (!user) return false;

    try {
      const toValidate: string[] = [];
      if (panels.has('profile')) toValidate.push('email', 'name', 'role');
      if (panels.has('security')) toValidate.push('unix_username');
      if (toValidate.length) await form.validateFields(toValidate);

      const updates: UpdateUserInput = {};
      const nextPreferences: NonNullable<UpdateUserInput['preferences']> = { ...user.preferences };
      let preferencesTouched = false;

      if (panels.has('profile')) {
        const values = form.getFieldsValue(['email', 'name', 'role', 'useSlackAvatar']);
        updates.email = values.email;
        updates.name = values.name;
        updates.role = values.role;
        if (values.useSlackAvatar === false) {
          nextPreferences.use_slack_avatar = false;
        } else {
          delete nextPreferences.use_slack_avatar;
        }
        preferencesTouched = true;
      }

      if (panels.has('security')) {
        const values = form.getFieldsValue(['unix_username', 'password']);
        updates.unix_username = values.unix_username;
        if (values.password?.trim()) updates.password = values.password;
      }

      if (panels.has('preferences')) {
        const audioValues = audioForm.getFieldsValue();
        nextPreferences.audio = {
          enabled: audioValues.enabled,
          chime: audioValues.chime,
          volume: audioValues.volume,
          minDurationSeconds: audioValues.minDurationSeconds,
        };
        nextPreferences.eventStream = { enabled: form.getFieldValue('eventStreamEnabled') ?? true };
        preferencesTouched = true;
      }

      // The force-password-change control now renders in the Security panel
      // (its rendering moved from Access; the gate is unchanged).
      if (panels.has('security') && isAdmin && isEditingOther) {
        updates.must_change_password = form.getFieldValue('must_change_password');
      }

      if (preferencesTouched) updates.preferences = nextPreferences;

      if (Object.keys(updates).length > 0) await onUpdate?.(user.user_id, updates);
      if (panels.has('security')) form.setFieldValue('password', '');
      if (panels.has('access')) await syncUserGroups(form.getFieldValue('groupIds') || []);
      return true;
    } catch (err) {
      console.error('Failed to save settings:', err);
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
      await agenticFormByTool[tool].validateFields();
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
      // Field set is owned by ApiKeyFields' `TOOL_FIELD_CONFIGS`. Claude and Codex
      // expose an explicit method so dormant credentials are never selected by accident.
      const allToolFields = TOOL_FIELD_CONFIGS[tool] ?? [];
      const fieldStatus: FieldStatus = agenticToolStatus[tool] ?? {};
      const authMethod =
        tool === 'claude-code'
          ? (agenticAuthMethods['claude-code'] ??
            (fieldStatus.CLAUDE_CODE_OAUTH_TOKEN ? 'subscription' : 'api_key'))
          : tool === 'codex'
            ? (agenticAuthMethods.codex ?? 'api_key')
            : undefined;
      const toolFields = allToolFields.filter((field) => {
        if (tool === 'claude-code') {
          return authMethod === 'subscription'
            ? field.field === 'CLAUDE_CODE_OAUTH_TOKEN'
            : field.field !== 'CLAUDE_CODE_OAUTH_TOKEN';
        }
        return tool !== 'codex' || authMethod === 'api_key';
      });
      const tenantSettings = tenantToolSettings.get(tool as TenantAgenticToolName);
      const resolutionPolicy = tenantSettings?.resolution_policy ?? 'user_preferred';
      const personalConfigured =
        (tool === 'codex' && authMethod === 'subscription') ||
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
      const status: AgenticToolReadiness =
        effectiveSource === 'Unavailable'
          ? { tone: 'neutral', label: 'Not connected' }
          : managedByWorkspace
            ? { tone: 'info', label: 'Managed by workspace' }
            : { tone: 'positive', label: 'Connected' };
      return {
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

  const statusDotColor = useMemo<Record<AgenticToolReadiness['tone'], string>>(
    () => ({
      positive: token.colorSuccess,
      neutral: token.colorTextQuaternary,
      info: token.colorPrimary,
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
        provider?: {
          tool: AgenticToolName;
          fallbackStatus: AgenticToolReadiness;
        };
      }>;
    }> = [
      {
        key: 'grp-account',
        label: 'Account',
        children: [
          { key: 'profile', ...PANEL_META.profile },
          { key: 'preferences', ...PANEL_META.preferences },
          { key: 'security', ...PANEL_META.security },
          // Personal API tokens and uploads are scoped to the signed-in caller,
          // so they are meaningless (and misleading) when an admin edits another
          // user.
          ...(isEditingOther
            ? []
            : [
                { key: 'tokens', ...PANEL_META.tokens },
                { key: 'uploads', ...PANEL_META.uploads },
              ]),
        ],
      },
      {
        key: 'grp-providers',
        label: 'AI Providers',
        children: visibleAgenticToolTabs.map((tool) => ({
          key: providerKeyFor(tool),
          title: AGENTIC_TOOL_DISPLAY_NAMES[tool],
          provider: { tool, fallbackStatus: resolveProvider(tool).status },
        })),
      },
      {
        key: 'grp-environment',
        label: 'Environment',
        children: [{ key: 'env-vars', ...PANEL_META['env-vars'] }],
      },
    ];

    if (isAdmin) {
      groups.push({
        key: 'grp-admin',
        label: 'Admin',
        children: [{ key: 'access', ...PANEL_META.access }],
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
          label: child.provider ? (
            <AgenticToolReadinessSlot
              tool={child.provider.tool}
              client={client}
              canLoadReadiness={isSelf}
              fallback={child.provider.fallbackStatus}
            >
              {(status) => (
                <Space size={8}>
                  <Badge color={statusDotColor[status.tone]} />
                  <span>{child.title}</span>
                  <span style={SR_ONLY_STYLE}>{status.label}</span>
                </Space>
              )}
            </AgenticToolReadinessSlot>
          ) : (
            child.title
          ),
        })),
      })),
    [client, isSelf, navGroups, statusDotColor]
  );

  const activeInNav = navGroups.some((group) =>
    group.children.some((child) => child.key === activeKey)
  );

  // Global search index across every panel's contents. Settings are pushed
  // before pages so that, among equally-ranked keyword-only hits, a specific
  // setting sorts ahead of a broad page-alias hit. Labels mirror the RENDERED
  // labels so searching what's on screen finds it; the friendly/older phrasing
  // lives in `keywords`.
  const settingsIndex = useMemo<SettingIndexEntry[]>(() => {
    const entries: SettingIndexEntry[] = [
      { label: 'Name', kind: 'setting', panelKey: 'profile' },
      { label: 'Emoji', kind: 'setting', keywords: 'avatar icon', panelKey: 'profile' },
      { label: 'Email', kind: 'setting', panelKey: 'profile' },
      {
        label: 'Use Slack avatar when available',
        kind: 'setting',
        keywords: 'profile image picture',
        panelKey: 'profile',
      },
      {
        label: 'Role',
        kind: 'setting',
        keywords: 'permission admin member viewer',
        panelKey: 'profile',
      },
      {
        label: 'Password',
        kind: 'setting',
        keywords: 'credentials security',
        panelKey: 'security',
      },
      {
        label: 'Execution home key',
        kind: 'setting',
        keywords: 'impersonation os process user',
        panelKey: 'security',
      },
      {
        label: 'Enable chimes',
        kind: 'setting',
        keywords: 'sound audio notification',
        panelKey: 'preferences',
      },
      {
        label: 'Volume',
        kind: 'setting',
        keywords: 'sound audio loudness',
        panelKey: 'preferences',
      },
      {
        label: 'Chime sound',
        kind: 'setting',
        keywords: 'audio notification tone',
        panelKey: 'preferences',
      },
      {
        label: 'Only play for tasks longer than',
        kind: 'setting',
        keywords: 'minimum task duration chime seconds threshold',
        panelKey: 'preferences',
      },
      {
        label: 'Live event stream',
        kind: 'setting',
        keywords: 'websocket debug beta navbar',
        panelKey: 'preferences',
      },
    ];
    if (isSelf && onRestartOnboarding) {
      entries.push({
        label: 'Restart onboarding',
        kind: 'setting',
        keywords: 'wizard setup teammate',
        panelKey: 'profile',
      });
    }
    if (!isEditingOther) {
      entries.push({
        label: 'Create New Key',
        kind: 'setting',
        keywords: 'api token new create',
        panelKey: 'tokens',
      });
    }
    if (isAdmin) {
      entries.push({
        label: 'Groups',
        kind: 'setting',
        keywords: 'membership branch permissions',
        panelKey: 'access',
      });
    }
    if (isAdmin && isEditingOther) {
      entries.push({
        label: 'Force password change on next login',
        kind: 'setting',
        keywords: 'security reset',
        panelKey: 'access',
      });
    }
    // Provider entries mirror ONLY what each tool actually renders: the
    // Authentication tab exists solely when the tool has credential fields, the
    // Session defaults tab always renders its strategy/MCP controls, and the
    // model label matches the real rendered label (e.g. "OpenCode LLM Provider").
    for (const tool of visibleAgenticToolTabs) {
      const name = AGENTIC_TOOL_DISPLAY_NAMES[tool];
      const providerKey = providerKeyFor(tool);
      const kw = (extra: string) => `${name} ${tool} ${extra}`;
      // `allToolFields` decides whether an Authentication pane exists at all;
      // `toolFields` is the subset actually rendered for the effective auth
      // method — index only those so every credential hit lands on a VISIBLE
      // control (e.g. no OpenAI key entry while Codex is on a ChatGPT login).
      const { allToolFields, toolFields } = resolveProvider(tool);

      if (allToolFields.length > 0) {
        entries.push({
          label: 'Authentication',
          kind: 'setting',
          keywords: kw('api key credentials sign in oauth'),
          panelKey: providerKey,
          subtab: 'auth',
        });
        for (const field of toolFields) {
          entries.push({
            label: field.label,
            kind: 'setting',
            keywords: kw('credentials'),
            panelKey: providerKey,
            subtab: 'auth',
          });
        }
      }

      entries.push(
        {
          label: 'Session defaults',
          kind: 'setting',
          keywords: kw('permission mode model mcp effort preset'),
          panelKey: providerKey,
          subtab: 'defaults',
        },
        {
          label: 'Default for new configurations',
          kind: 'setting',
          keywords: kw('workspace preset inline strategy'),
          panelKey: providerKey,
          subtab: 'defaults',
        },
        {
          label: 'MCP servers',
          kind: 'setting',
          keywords: kw('tools'),
          panelKey: providerKey,
          subtab: 'defaults',
        },
        {
          label: 'Preset',
          kind: 'setting',
          keywords: kw('configuration'),
          panelKey: providerKey,
          subtab: 'defaults',
        },
        {
          label: modelLabelForTool(tool),
          kind: 'setting',
          keywords: kw('alias'),
          panelKey: providerKey,
          subtab: 'defaults',
        },
        {
          label: 'Permission Mode',
          kind: 'setting',
          keywords: kw('approval'),
          panelKey: providerKey,
          subtab: 'defaults',
        }
      );
      if (AGENTIC_TOOL_CAPABILITIES[tool]?.reasoningEffortLevels) {
        entries.push({
          label: 'Reasoning Effort',
          kind: 'setting',
          keywords: kw('thinking'),
          panelKey: providerKey,
          subtab: 'defaults',
        });
      }
      if (tool === 'codex') {
        entries.push(
          {
            label: 'Sandbox Mode',
            kind: 'setting',
            keywords: kw('filesystem'),
            panelKey: providerKey,
            subtab: 'defaults',
          },
          {
            label: 'Approval Policy',
            kind: 'setting',
            keywords: kw('commands'),
            panelKey: providerKey,
            subtab: 'defaults',
          },
          {
            label: 'Network Access',
            kind: 'setting',
            keywords: kw('http outbound'),
            panelKey: providerKey,
            subtab: 'defaults',
          }
        );
      }
    }
    // Pages last: one per nav item, from the single source of truth (navGroups).
    for (const group of navGroups) {
      for (const child of group.children) {
        const isProvider = child.key.startsWith(PROVIDER_KEY_PREFIX);
        entries.push({
          label: panelTitleForKey(child.key),
          kind: 'page',
          panelKey: child.key,
          keywords: isProvider
            ? `${toolFromProviderKey(child.key)} provider ai model`
            : PANEL_META[child.key]?.keywords,
        });
      }
    }
    return entries;
  }, [
    navGroups,
    visibleAgenticToolTabs,
    resolveProvider,
    isAdmin,
    isEditingOther,
    isSelf,
    onRestartOnboarding,
  ]);

  const searchActive = search.trim().length > 0;

  // Relevance ranking, most significant first: (1) a matched page/tab name;
  // (2) a setting that lives in a matched tab (tab-membership outranks how the
  // setting matched, so a keyword-only hit in the matched tab still beats a
  // label hit elsewhere); (3) a label match over a keyword/alias-only match;
  // (4) a prefix over a mid-substring; (5) index for a stable, deterministic tie.
  const searchResults = useMemo(() => {
    if (!searchActive) return [];
    const fullQuery = search.trim().toLowerCase();
    const tokens = getSettingsSearchTokens(search);
    const labelHasEveryToken = (entry: SettingIndexEntry) => {
      const labelLc = entry.label.toLowerCase();
      return tokens.every((token) => labelLc.includes(token));
    };
    const matched = settingsIndex
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) =>
        matchesSettingsSearchTokens(entry, tokens, [(e) => e.label, (e) => e.keywords])
      );
    const matchedTabKeys = new Set(
      matched.filter(({ entry }) => isPageMatch(entry, tokens)).map(({ entry }) => entry.panelKey)
    );
    return matched
      .map(({ entry, index }) => ({
        entry,
        index,
        t1: isPageMatch(entry, tokens) ? 0 : 1,
        t2: matchedTabKeys.has(entry.panelKey) ? 0 : 1,
        t3: labelHasEveryToken(entry) ? 0 : 1,
        t4: entry.label.toLowerCase().startsWith(fullQuery) ? 0 : 1,
      }))
      .sort((a, b) => a.t1 - b.t1 || a.t2 - b.t2 || a.t3 - b.t3 || a.t4 - b.t4 || a.index - b.index)
      .map(({ entry }) => entry);
  }, [settingsIndex, search, searchActive]);

  const searchMenuItems: MenuProps['items'] = useMemo(() => {
    const tokens = getSettingsSearchTokens(search);
    // Page hits are ranked first; drop a divider before the first non-page hit
    // only when both kinds are present (no dangling divider).
    const showDivider =
      searchResults.some((entry) => isPageMatch(entry, tokens)) &&
      searchResults.some((entry) => !isPageMatch(entry, tokens));
    const items: NonNullable<MenuProps['items']> = [];
    let dividerPlaced = false;
    searchResults.forEach((entry, index) => {
      if (showDivider && !dividerPlaced && !isPageMatch(entry, tokens)) {
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
    // Provider hits carry the sub-tab they live on so a "Session defaults"
    // result opens the defaults pane, not the default Authentication view. Set
    // it directly (covers the already-active provider, where the reset effect
    // won't re-fire) and queue it scoped to the target for the tab switch.
    if (entry.subtab) {
      pendingProviderSubtabRef.current = { panelKey: entry.panelKey, subtab: entry.subtab };
      setProviderSubtab(entry.subtab);
    }
    setActiveKey(entry.panelKey);
    setSearch('');
  };

  const isInlineSavePanel =
    activeKey === 'env-vars' ||
    activeKey === 'tokens' ||
    activeKey === 'uploads' ||
    (!!activeTool && providerSubtab === 'auth');

  // Unified footer action. Batch panels commit their edits and close; inline
  // panels (env vars, tokens, provider auth) have already persisted per row /
  // per field, so "Done" only flushes any dirty session-defaults left over
  // from another provider before closing.
  const handleModalSave = async () => {
    if (!user || savingModal) return;
    setSavingModal(true);
    try {
      // Flush EVERY edited main panel (plus the active one if it owns the shared
      // form), regardless of which panel is in view — a dirty Profile edit must
      // survive saving from a provider tab just as it does from another main
      // panel. Commit these FIRST and abort the close on validation failure.
      const mainPanels = new Set(dirtyMainPanels);
      if (MAIN_FORM_KEYS.includes(activeKey as (typeof MAIN_FORM_KEYS)[number])) {
        mainPanels.add(activeKey);
      }
      if (mainPanels.size > 0 && !(await commitMainPanels(mainPanels))) return;

      // Then persist agentic configs once: the active provider's session
      // defaults plus any dirty defaults left over from other provider tabs.
      if (activeTool && providerSubtab === 'defaults') {
        await handleAgenticConfigSave(activeTool);
      } else {
        await saveDirtyAgenticConfigs();
      }
      handleClose();
    } finally {
      setSavingModal(false);
    }
  };

  const renderProfilePanel = () => (
    <>
      <PanelHeader title={PANEL_META.profile.title} />
      <Form form={form} layout="vertical" onValuesChange={() => markMainPanelDirty('profile')}>
        <FieldRow label="Name" name="name" width="short">
          <Input placeholder="John Doe" />
        </FieldRow>

        <FieldRow
          label="Email"
          required
          name="email"
          width="medium"
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
          tooltip="Shows your Slack-synced profile image instead of your initials tile. Turns off automatically if Slack sync is removed."
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
      <PanelHeader title={PANEL_META.security.title} />
      <Form form={form} layout="vertical" onValuesChange={() => markMainPanelDirty('security')}>
        <FieldRow label="Password" name="password" help="Leave blank to keep current password">
          <Input.Password placeholder="••••••••" />
        </FieldRow>

        {isAdmin && isEditingOther && (
          <Form.Item name="must_change_password" valuePropName="checked">
            <Checkbox>Force password change on next login</Checkbox>
          </Form.Item>
        )}

        <FieldRow
          label="Execution home key"
          name="unix_username"
          help={
            isAdmin
              ? 'Transitional home key used only by delegated execution'
              : 'Maintained by administrators'
          }
          rules={[
            {
              pattern: EXECUTION_HOME_KEY_PATTERN,
              message:
                'Start with a lowercase letter or underscore; then use lowercase letters, numbers, hyphens, or underscores',
            },
            { max: 32, message: 'Execution home key must be 32 characters or less' },
          ]}
        >
          <Input placeholder="johnsmith" maxLength={32} disabled={!isAdmin} />
        </FieldRow>
      </Form>
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0 }}>
        Looking for API keys and model provider credentials? Those live under{' '}
        <strong>AI Providers</strong> in the sidebar, scoped per user so they never leak across
        accounts.
      </Typography.Paragraph>
    </>
  );

  const renderPreferencesPanel = () => (
    <>
      <PanelHeader title={PANEL_META.preferences.title} />
      <AudioSettingsTab form={audioForm} onValuesChange={() => markMainPanelDirty('preferences')} />
      <SectionDivider label="Interface" />
      <Form form={form} layout="vertical" onValuesChange={() => markMainPanelDirty('preferences')}>
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
      <PanelHeader title={PANEL_META['env-vars'].title} />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Environment variables are encrypted at rest and available to all sessions for this user.
      </Typography.Paragraph>
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title={
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
      <PanelHeader title={PANEL_META.access.title} />
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Add or remove this user from admin-managed groups.
      </Typography.Paragraph>
      <Form form={form} layout="vertical" onValuesChange={() => markMainPanelDirty('access')}>
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
      </Form>
    </>
  );

  const renderProviderPanel = (tool: AgenticToolName) => {
    const currentForm = agenticFormByTool[tool];
    const displayName = AGENTIC_TOOL_DISPLAY_NAMES[tool];
    const ProviderSettings = getAgenticToolUIIntegration(tool)?.ProviderSettings;
    const {
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
      toolFields.map((c) => [c.field, !!savingToolField[`${tool}.${c.field}`]])
    );

    const statusTag = (
      <AgenticToolReadinessSlot
        tool={tool}
        client={client}
        canLoadReadiness={isSelf}
        fallback={status}
      >
        {agenticToolReadinessTag}
      </AgenticToolReadinessSlot>
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
          onValuesChange={(changed, allValues) => {
            setAgenticConfigDraftByTool((prev) => ({ ...prev, [tool]: allValues }));
            markAgenticConfigDirty(tool);
            // The MCP list is user-level; remember who touched it last so Save
            // reads this tool's value rather than the dirty set's first tool.
            if (changed && 'mcpServerIds' in changed) setMcpEditSourceTool(tool);
          }}
        >
          <UserAgenticDefaultEditor
            tool={tool}
            client={client}
            modelCatalogClient={
              user?.user_id && user.user_id === currentUser?.user_id ? client : null
            }
            isAdmin={isAdmin}
          />
          <SessionMcpServersField mcpServerById={mcpServerById} showHelpText={false} />
        </Form>
        <Divider style={{ margin: '20px 0' }} />
        <Button danger type="text" onClick={() => handleAgenticConfigClear(tool)}>
          Clear defaults
        </Button>
      </>
    );

    if (ProviderSettings) {
      let providersPane = (
        <Alert
          type="info"
          showIcon
          title={`${displayName} connections can only be managed by that user.`}
        />
      );
      if (isSelf && client) {
        providersPane = (
          <ProviderSettings key={currentUser?.user_id} client={client} copyText={copyToClipboard} />
        );
      } else if (isSelf) {
        providersPane = <Alert type="warning" showIcon title="Not connected to Agor." />;
      }

      return (
        <>
          {header}
          <Tabs
            activeKey={providerSubtab}
            onChange={(key) => setProviderSubtab(key as ProviderSubtab)}
            items={[
              { key: 'auth', label: 'Providers', children: providersPane },
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
    }

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
        title="Authentication is managed by this workspace — your personal configuration is never used while this policy is active."
        style={{ marginBottom: 16 }}
      />
    ) : effectiveSource === 'Unavailable' ? (
      <Alert
        type="warning"
        showIcon
        title="No credentials configured yet"
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
                      await handleToolFieldClear(tool, field.field);
                    }
                  }
                  if (tool === 'codex') {
                    await handleAuthMethodChange('codex', 'api_key');
                  }
                }}
              >
                <Button danger>Delete saved personal configuration</Button>
              </Popconfirm>
            </Space>
          )
        ) : tool === 'codex' ? (
          <CodexAuthSettings
            client={client}
            authMethod={authMethod ?? 'api_key'}
            allowChatgptLogin={isSelf}
            apiKeyFields={allToolFields}
            fieldStatus={fieldStatus}
            onSaveField={(field, value) => handleToolFieldSave(tool, field, value)}
            onClearField={(field) => handleToolFieldClear(tool, field)}
            savingFields={Object.fromEntries(
              allToolFields.map((c) => [c.field, !!savingToolField[`${tool}.${c.field}`]])
            )}
            publicValues={
              user?.agentic_tools_public_values?.[tool] as
                | Partial<Record<AgenticToolConfigField, string>>
                | undefined
            }
          />
        ) : (
          <Form component={false} layout="vertical">
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Personal credentials are encrypted at rest and injected only into the agent runtime.
            </Typography.Paragraph>
            {tool === 'claude-code' && (
              <FieldRow
                label="Sign-in method"
                tooltip="Choose one — Agor uses whichever is selected, the other is ignored."
              >
                <Radio.Group
                  buttonStyle="solid"
                  value={authMethod}
                  onChange={(event) => void handleAuthMethodChange(tool, event.target.value)}
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
              onSave={(field, value) => handleToolFieldSave(tool, field, value)}
              onClear={(field) => handleToolFieldClear(tool, field)}
              saving={savingForTool}
              publicValues={
                user?.agentic_tools_public_values?.[tool] as
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
            <PanelHeader title={PANEL_META.tokens.title} />
            <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
              Agor API tokens allow you to authenticate with the Agor API from scripts, CI
              pipelines, and external tools. Tokens have the same permissions as your user account.
            </Typography.Paragraph>
            <PersonalApiKeysTab client={client} />
          </>
        );
      case 'uploads':
        return (
          <>
            <PanelHeader title={PANEL_META.uploads.title} />
            <UploadsTab />
          </>
        );
      case 'access':
        return renderAccessPanel();
      default:
        return renderProfilePanel();
    }
  };

  // With the modal header bar removed, the identity lives at the top of the
  // elevated sider — including the "Editing <user>" indicator for admins.
  const siderTitle = isEditingOther ? (
    <Space size={8} align="center">
      <UserIdentityAvatar user={user} size={24} fontSize="14px" />
      <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
        Editing {user?.name || user?.email}
      </Typography.Text>
    </Space>
  ) : (
    // Text-only label, matching Workspace Settings' header (whose leading icon
    // was dropped because at the Sider width the icon + text wrapped to two
    // lines). The distinct wording — "User Settings" vs "Workspace Settings" —
    // is what marks the two surfaces as a matched pair now.
    <Typography.Text strong style={{ fontSize: token.fontSizeLG }}>
      User Settings
    </Typography.Text>
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

  // Keep inactive form instances connected to Ant Form. Without these
  // lightweight hidden connectors, calling form methods while switching panels
  // can produce noisy "useForm is not connected" console warnings.
  const hiddenForms = (
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
  );

  const layoutBody = (
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
          <div style={{ padding: `0 ${token.marginXXS}px ${token.marginMD}px` }}>{siderTitle}</div>
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
  );

  // Embedded nav is a horizontal Tabs bar, not a second Sider+Menu — otherwise
  // drilling in from Workspace Settings stacks three nav columns on screen. The
  // section list (and its isEditingOther tab-hiding) comes from the same
  // navGroups the Sider uses; groups are flattened and overflow into Tabs' own
  // "more" dropdown when there are many providers.
  const embeddedTabItems = navGroups.flatMap((group) =>
    group.children.map((child) => ({
      key: child.key,
      label: child.provider ? (
        <AgenticToolReadinessSlot
          tool={child.provider.tool}
          client={client}
          canLoadReadiness={isSelf}
          fallback={child.provider.fallbackStatus}
        >
          {(status) => (
            <Space size={6}>
              {child.icon}
              <Badge color={statusDotColor[status.tone]} />
              <span>{child.title}</span>
              <span style={SR_ONLY_STYLE}>{status.label}</span>
            </Space>
          )}
        </AgenticToolReadinessSlot>
      ) : (
        <Space size={6}>
          {child.icon}
          <span>{child.title}</span>
        </Space>
      ),
    }))
  );

  // Drill-in mode: no outer Modal. A Back affordance replaces the modal close,
  // and this component keeps its own footer (its inline-save caption differs
  // per panel) rendered as a bottom bar.
  if (embedded) {
    return (
      <Flex vertical style={{ height: '100%', background: token.colorBgContainer }}>
        <div
          style={{
            padding: '10px 16px',
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          <Button type="text" icon={<ArrowLeftOutlined />} onClick={handleClose}>
            {backLabel}
          </Button>
        </div>
        {hiddenForms}
        {/* Persistent, non-dismissible banner so you never lose track of whose
            account you're editing (only when editing someone else). */}
        {isEditingOther && (
          <Alert
            type="info"
            showIcon
            icon={<UserOutlined />}
            message={`You are editing ${user?.name || user?.email || 'this user'}'s account settings`}
            style={{ borderRadius: 0 }}
          />
        )}
        <ConfigProvider theme={scopedTheme}>
          <Tabs
            activeKey={activeInNav ? activeKey : undefined}
            onChange={setActiveKey}
            items={embeddedTabItems}
            tabBarStyle={{ padding: '0 24px', marginBottom: 0 }}
          />
        </ConfigProvider>
        <div style={{ flex: 1, minHeight: 0, overflow: 'auto', padding: '20px 24px' }}>
          {renderContent()}
        </div>
        <div
          style={{
            padding: '12px 24px',
            background: token.colorBgContainer,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: token.marginXS,
          }}
        >
          {footer}
        </div>
      </Flex>
    );
  }

  return (
    <Modal
      open={open}
      onCancel={handleClose}
      // The header bar is hidden (styles.header), but the dialog still needs an
      // accessible name: this `title` becomes rc-dialog's `aria-labelledby`
      // target (its text is used for the name even though the header is
      // `display: none`), so screen readers announce the dialog.
      title="User Settings"
      footer={footer}
      closable
      closeIcon={<CloseOutlined />}
      width="min(1050px, calc(100vw - 32px))"
      styles={{
        // Zero the card's default 20px 24px frame and clip to the rounded
        // corners so the inner Layout fills the card edge-to-edge — the Sider
        // sits flush against the modal's rounded left/top/bottom edges instead
        // of floating inside a colorBgElevated padding frame (AntD v6: the card
        // slot — rendered `.ant-modal-container` — is the `container` key).
        container: { padding: 0, overflow: 'hidden' },
        header: { display: 'none' },
        body: {
          padding: 0,
          height: 'calc(100vh - 280px)',
          minHeight: 450,
          maxHeight: 650,
        },
        // With the card frame gone, the footer supplies its own padding and a
        // top divider so it reads as one bar across the bottom of the card.
        footer: {
          margin: 0,
          padding: '12px 24px',
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        },
      }}
    >
      {hiddenForms}
      {layoutBody}
    </Modal>
  );
};
