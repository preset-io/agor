import type {
  AgenticToolName,
  AgenticToolPreset,
  AgorClient,
  DefaultAgenticToolConfig,
  EffortLevel,
  MCPServer,
  PermissionMode,
  User,
} from '@agor-live/client';
import {
  canonicalTenantAgenticTool,
  getDefaultModelForTool,
  getDefaultPermissionMode,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import {
  ApiOutlined,
  ExperimentOutlined,
  InfoCircleOutlined,
  RobotOutlined,
  SettingOutlined,
} from '@ant-design/icons';
import { Checkbox, Flex, Form, Menu, Popover, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useAgorStore } from '../../store/agorStore';
import {
  INLINE_AGENTIC_CONFIGURATION,
  SAVE_AS_DEFAULT_FIELD,
} from '../AgenticToolConfigurationPicker';
import { EffortSelector } from '../EffortSelector';
import { MCPServerSelect } from '../MCPServerSelect';
import {
  AdvisorModelSelect,
  getModelDisplayName,
  type ModelConfig,
  ModelSelector,
} from '../ModelSelector';
import {
  getPermissionModeColor,
  getPermissionModeLabel,
  getPermissionModeMeta,
  PermissionModeSelector,
} from '../PermissionModeSelector';
import { Tag } from '../Tag';

export interface AgenticConfigChipRowProps {
  tool: AgenticToolName;
  client: AgorClient | null;
  mcpServerById: Map<string, MCPServer>;
  currentUser?: User | null;
  /** Form field holding the configuration source. */
  fieldName?: string;
  /** Offer "Save as my default" in the source popover while Custom is active. */
  enableSaveAsDefault?: boolean;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

const CLAUDE_TOOLS = new Set<AgenticToolName>(['claude-code', 'claude-code-cli']);

/**
 * Renders nothing but lets a `Form.Item` register a field so `Form.useWatch`
 * stays reactive to `setFieldValue` (the chips edit values imperatively rather
 * than through mounted controls).
 */
const HiddenField: React.FC<{ value?: unknown; onChange?: (value: unknown) => void }> = () => null;

/** "Model · Permission" summary of a concrete config, for the source options. */
function summarize(tool: AgenticToolName, config?: DefaultAgenticToolConfig): string {
  if (!config) return '';
  const parts: string[] = [];
  if (config.modelConfig?.model) parts.push(getModelDisplayName(tool, config.modelConfig.model));
  if (config.permissionMode) parts.push(getPermissionModeLabel(tool, config.permissionMode));
  return parts.join(' · ');
}

/** Short model name for a chip ("Claude Opus 4.8" → "Opus 4.8"). */
function shortModelName(tool: AgenticToolName, modelId: string): string {
  return getModelDisplayName(tool, modelId).replace(/^Claude\s+/, '');
}

/**
 * Session-drawer-style chip row for agentic configuration. Renders the resolved
 * config (source / model / permission / effort / MCP / advisor) as clickable
 * chips whose popovers edit the underlying form fields. Editing a config chip
 * while a preset/default is selected switches the source to inline ("Custom"),
 * seeded from the resolved values — producing the same submit payload as the
 * explicit "Customize" path.
 */
export const AgenticConfigChipRow: React.FC<AgenticConfigChipRowProps> = ({
  tool,
  client,
  mcpServerById,
  currentUser,
  fieldName = 'agenticToolPresetId',
  enableSaveAsDefault = false,
}) => {
  const { token } = theme.useToken();
  const form = Form.useFormInstance();
  const canonicalTool = canonicalTenantAgenticTool(tool);
  const settings = useAgorStore((state) => state.agenticToolSettingsByName?.get(canonicalTool));
  const inlineAllowed = settings?.inline_configuration_allowed !== false;
  const isClaude = CLAUDE_TOOLS.has(tool);

  const [presets, setPresets] = useState<AgenticToolPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [shown, setShown] = useState(false);

  // Subtle fade-in when the row (re)renders for a newly selected tool.
  // biome-ignore lint/correctness/useExhaustiveDependencies: fade should retrigger per tool
  useEffect(() => {
    setShown(false);
    const id = requestAnimationFrame(() => setShown(true));
    return () => cancelAnimationFrame(id);
  }, [tool]);

  useEffect(() => {
    if (!client) {
      setPresets([]);
      setLoading(false);
      return undefined;
    }
    let active = true;
    setLoading(true);
    const service = client.service('agentic-tool-presets');
    const refresh = () =>
      service
        .find({ query: { tool: canonicalTool } })
        .then((result: unknown) => {
          if (active) {
            const list = Array.isArray(result)
              ? result
              : ((result as { data: AgenticToolPreset[] }).data ?? []);
            setPresets(list as AgenticToolPreset[]);
          }
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    void refresh();
    service.on('created', refresh);
    service.on('patched', refresh);
    service.on('removed', refresh);
    return () => {
      active = false;
      service.off('created', refresh);
      service.off('patched', refresh);
      service.off('removed', refresh);
    };
  }, [canonicalTool, client]);

  const source = Form.useWatch(fieldName, form) as string | undefined;
  const formModelConfig = Form.useWatch('modelConfig', form) as ModelConfig | undefined;
  const formEffort = Form.useWatch('effort', form) as EffortLevel | undefined;
  const formPermission = Form.useWatch('permissionMode', form) as PermissionMode | undefined;
  const formMcp = Form.useWatch('mcpServerIds', form) as string[] | undefined;

  const userSelection = currentUser?.default_agentic_selection?.[canonicalTool];
  const userConfigBlob = currentUser?.default_agentic_config?.[canonicalTool];
  const hasUserDefault = currentUser ? Boolean(userSelection ?? userConfigBlob) : true;
  const workspacePreset = presets.find((preset) => preset.is_default);
  const isInline = source === INLINE_AGENTIC_CONFIGURATION;

  // Keep the source valid — mirrors the daemon's resolution precedence.
  useEffect(() => {
    if (loading) return;
    const valid =
      presets.some((preset) => preset.preset_id === source) ||
      (source === USER_DEFAULT_AGENTIC_CONFIGURATION && hasUserDefault) ||
      source === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION ||
      (inlineAllowed && source === INLINE_AGENTIC_CONFIGURATION);
    if (valid) return;
    form.setFieldValue(
      fieldName,
      hasUserDefault
        ? USER_DEFAULT_AGENTIC_CONFIGURATION
        : inlineAllowed
          ? INLINE_AGENTIC_CONFIGURATION
          : WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
    );
  }, [fieldName, form, hasUserDefault, inlineAllowed, loading, presets, source]);

  const configForSource = (src: string | undefined): DefaultAgenticToolConfig => {
    if (src === INLINE_AGENTIC_CONFIGURATION) {
      return { modelConfig: formModelConfig, permissionMode: formPermission };
    }
    if (src === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
      return workspacePreset?.configuration ?? {};
    if (src === USER_DEFAULT_AGENTIC_CONFIGURATION) {
      if (userSelection?.source === 'preset') {
        return presets.find((p) => p.preset_id === userSelection.preset_id)?.configuration ?? {};
      }
      if (userSelection?.source === 'workspace_default')
        return workspacePreset?.configuration ?? {};
      return userConfigBlob ?? {};
    }
    return presets.find((p) => p.preset_id === src)?.configuration ?? {};
  };

  const resolved = configForSource(source);
  const resolvedModel = resolved.modelConfig?.model || getDefaultModelForTool(tool) || '';
  const resolvedPermission = resolved.permissionMode || getDefaultPermissionMode(tool);
  const resolvedEffort = isInline ? formEffort : resolved.modelConfig?.effort;
  const advisorModel = isInline ? formModelConfig?.advisorModel : undefined;
  const mcpCount = formMcp?.length ?? 0;

  const sourceTitle = (src: string | undefined): string => {
    if (src === INLINE_AGENTIC_CONFIGURATION) return 'Custom';
    if (src === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
      return workspacePreset ? workspacePreset.name : 'Workspace default';
    if (src === USER_DEFAULT_AGENTIC_CONFIGURATION) return 'My default';
    return presets.find((p) => p.preset_id === src)?.name ?? 'Preset';
  };

  // Seed inline fields from the currently-resolved config, then flip to Custom.
  const seedCustom = () => {
    const current = configForSource(source);
    form.setFieldsValue({
      [fieldName]: INLINE_AGENTIC_CONFIGURATION,
      modelConfig: current.modelConfig ?? {
        mode: 'alias',
        model: getDefaultModelForTool(tool) || '',
      },
      effort: current.modelConfig?.effort,
      permissionMode: current.permissionMode ?? getDefaultPermissionMode(tool),
      codexSandboxMode: current.codexSandboxMode,
      codexApprovalPolicy: current.codexApprovalPolicy,
      codexNetworkAccess: current.codexNetworkAccess,
    });
  };
  const ensureCustom = () => {
    if (!isInline) seedCustom();
  };

  const onModelChange = (next: ModelConfig) => {
    ensureCustom();
    form.setFieldValue('modelConfig', next);
  };
  const onPermissionChange = (mode: PermissionMode) => {
    ensureCustom();
    form.setFieldValue('permissionMode', mode);
  };
  const onEffortChange = (effort: EffortLevel) => {
    ensureCustom();
    form.setFieldValue('effort', effort);
  };
  const onAdvisorChange = (advisor: string | undefined) => {
    const current = (form.getFieldValue('modelConfig') as ModelConfig | undefined) ?? {
      mode: 'alias',
      model: resolvedModel,
    };
    form.setFieldValue('modelConfig', { ...current, advisorModel: advisor });
  };
  const onMcpChange = (ids: string[]) => form.setFieldValue('mcpServerIds', ids);
  const onSelectSource = (value: string) => {
    if (value === INLINE_AGENTIC_CONFIGURATION) seedCustom();
    else form.setFieldValue(fieldName, value);
  };

  const chipStyle = (editable: boolean, color?: string): React.CSSProperties => ({
    cursor: editable ? 'pointer' : 'default',
    height: 22,
    display: 'inline-flex',
    alignItems: 'center',
    maxWidth: 200,
    color,
  });

  const sourceOptions = [
    ...(hasUserDefault
      ? [
          {
            key: USER_DEFAULT_AGENTIC_CONFIGURATION,
            title: 'My default',
            summary:
              userSelection?.source === 'preset'
                ? sourceTitle(USER_DEFAULT_AGENTIC_CONFIGURATION)
                : summarize(canonicalTool, configForSource(USER_DEFAULT_AGENTIC_CONFIGURATION)),
          },
        ]
      : []),
    {
      key: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      title: workspacePreset ? `Workspace default · ${workspacePreset.name}` : 'Workspace default',
      summary: workspacePreset
        ? summarize(canonicalTool, workspacePreset.configuration)
        : 'not configured',
      disabled: !workspacePreset,
    },
    ...presets.map((preset) => ({
      key: preset.preset_id as string,
      title: preset.name,
      summary: summarize(canonicalTool, preset.configuration),
    })),
    ...(inlineAllowed
      ? [{ key: INLINE_AGENTIC_CONFIGURATION, title: 'Customize for this session…', summary: '' }]
      : []),
  ];

  const permissionMeta = getPermissionModeMeta(tool, resolvedPermission);
  const permissionColor =
    permissionMeta?.tone === 'warning' ? getPermissionModeColor('warning', token) : undefined;

  const managedNote = (
    <Typography.Text type="secondary">
      Managed by preset — switch presets to change.
    </Typography.Text>
  );

  const sourcePopover = (
    <div style={{ width: 320, maxWidth: '90vw' }}>
      <Menu
        selectable
        selectedKeys={source ? [source] : []}
        onClick={({ key }) => onSelectSource(key)}
        style={{ border: 'none' }}
        items={sourceOptions.map((option) => ({
          key: option.key,
          disabled: option.disabled,
          label: (
            <div style={{ lineHeight: token.lineHeightSM }}>
              <div>{option.title}</div>
              {option.summary && (
                <Typography.Text type="secondary" style={{ fontSize: token.fontSizeSM }}>
                  {option.summary}
                </Typography.Text>
              )}
            </div>
          ),
        }))}
      />
      {enableSaveAsDefault && isInline && currentUser && client && (
        <div style={{ padding: token.paddingXS }}>
          <Form.Item name={SAVE_AS_DEFAULT_FIELD} valuePropName="checked" noStyle>
            <Checkbox>Save as my default for {tool}</Checkbox>
          </Form.Item>
        </div>
      )}
    </div>
  );

  return (
    <div
      style={{
        opacity: shown ? 1 : 0,
        transition: `opacity ${token.motionDurationMid} ${token.motionEaseInOut}`,
      }}
    >
      {/* Register the fields the chips edit imperatively so useWatch stays reactive. */}
      {['agenticToolPresetId', 'modelConfig', 'permissionMode', 'effort', 'mcpServerIds'].map(
        (name) => (
          <Form.Item key={name} name={name === 'agenticToolPresetId' ? fieldName : name} noStyle>
            <HiddenField />
          </Form.Item>
        )
      )}
      <Flex gap={token.sizeUnit} align="center" wrap="wrap">
        {/* Source */}
        <Popover
          trigger="click"
          placement="bottomLeft"
          title="Configuration"
          content={sourcePopover}
        >
          <Tag
            icon={<SettingOutlined />}
            color="default"
            style={chipStyle(true)}
            data-testid="source-chip"
          >
            {sourceTitle(source)}
          </Tag>
        </Popover>

        {/* Model */}
        <EditableChip
          icon={<RobotOutlined />}
          label={shortModelName(tool, resolvedModel)}
          title="Model"
          editable={inlineAllowed}
          managedNote={managedNote}
          width={420}
          testid="model-chip"
          chipStyle={chipStyle(inlineAllowed)}
          content={
            <ModelSelector
              value={resolved.modelConfig as ModelConfig | undefined}
              onChange={onModelChange}
              agentic_tool={tool}
              client={client}
              showAdvisor={false}
            />
          }
        />

        {/* Permission */}
        <EditableChip
          icon={permissionMeta?.icon}
          label={getPermissionModeLabel(tool, resolvedPermission)}
          title="Permission mode"
          editable={inlineAllowed}
          managedNote={managedNote}
          width={340}
          testid="permission-chip"
          chipStyle={chipStyle(inlineAllowed, permissionColor)}
          content={
            <PermissionModeSelector
              value={resolvedPermission}
              onChange={onPermissionChange}
              agentic_tool={tool}
              fullWidth
            />
          }
        />

        {/* Effort (claude only) */}
        {isClaude && (
          <EditableChip
            icon={<ExperimentOutlined />}
            label={`Effort: ${resolvedEffort ? EFFORT_LABELS[resolvedEffort] : 'default'}`}
            title="Reasoning effort"
            editable={inlineAllowed}
            managedNote={managedNote}
            width={260}
            testid="effort-chip"
            chipStyle={chipStyle(inlineAllowed)}
            content={<EffortSelector value={resolvedEffort} onChange={onEffortChange} fullWidth />}
          />
        )}

        {/* MCP servers — orthogonal to preset config, always editable */}
        <EditableChip
          icon={<ApiOutlined />}
          label={mcpCount > 0 ? `${mcpCount} MCP` : 'No MCP'}
          title="MCP servers"
          editable
          width={360}
          testid="mcp-chip"
          chipStyle={chipStyle(true)}
          content={
            <MCPServerSelect
              mcpServers={mapToArray(mcpServerById)}
              value={formMcp}
              onChange={onMcpChange}
              placeholder="No MCP servers attached"
              style={{ width: '100%' }}
            />
          }
        />

        {/* Advisor — only meaningful (and applied) while inline config is active */}
        {isClaude && isInline && advisorModel && (
          <EditableChip
            icon={<InfoCircleOutlined />}
            label={`Advisor: ${shortModelName(tool, advisorModel)}`}
            title="Advisor model"
            editable
            width={360}
            testid="advisor-chip"
            chipStyle={chipStyle(true)}
            content={
              <AdvisorModelSelect value={advisorModel} onChange={onAdvisorChange} client={client} />
            }
          />
        )}
      </Flex>
    </div>
  );
};

interface EditableChipProps {
  icon?: React.ReactNode;
  label: string;
  title: string;
  editable: boolean;
  managedNote?: React.ReactNode;
  width: number;
  testid: string;
  chipStyle: React.CSSProperties;
  content: React.ReactNode;
}

/** A Tag chip that opens a popover editor on click (or shows a managed note). */
const EditableChip: React.FC<EditableChipProps> = ({
  icon,
  label,
  title,
  editable,
  managedNote,
  width,
  testid,
  chipStyle,
  content,
}) => {
  const chip = (
    <Tag icon={icon} color="default" style={chipStyle} data-testid={testid}>
      <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </span>
    </Tag>
  );

  if (!editable) {
    return (
      <Popover trigger="click" placement="bottomLeft" title={title} content={managedNote}>
        {chip}
      </Popover>
    );
  }

  return (
    <Popover
      trigger="click"
      placement="bottomLeft"
      title={title}
      overlayInnerStyle={{ padding: 8 }}
      content={<div style={{ width, maxWidth: '90vw' }}>{content}</div>}
    >
      {chip}
    </Popover>
  );
};
