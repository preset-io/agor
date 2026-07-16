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
} from '@ant-design/icons';
import { Checkbox, Flex, Form, Popover, Select, Typography, theme } from 'antd';
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
  /** Offer "Save as my default" under the chips while Custom is active. */
  enableSaveAsDefault?: boolean;
  /**
   * Reports whether the current source can actually resolve to a session
   * configuration. It only becomes false in the admin edge where inline config
   * is disallowed and no preset/default is available. `reason` explains why.
   */
  onConfigValidityChange?: (valid: boolean, reason?: string) => void;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

// The daemon treats an unset effort as "high" (see resolve-session-defaults),
// so the chip resolves to that effective value rather than showing "default".
const DEFAULT_EFFORT: EffortLevel = 'high';

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
 * Preset-plus-overrides configuration control: a full-width Select picks the
 * source (My default / workspace default / preset / Custom); a row of chips
 * below always renders the RESOLVED values. Editing any chip flips the Select
 * to "Custom" (inline config seeded from the resolved values) — the same submit
 * payload as choosing "Custom" outright. Form state is the single source of
 * truth via `Form.useWatch`.
 */
export const AgenticConfigChipRow: React.FC<AgenticConfigChipRowProps> = ({
  tool,
  client,
  mcpServerById,
  currentUser,
  fieldName = 'agenticToolPresetId',
  enableSaveAsDefault = false,
  onConfigValidityChange,
}) => {
  const { token } = theme.useToken();
  const form = Form.useFormInstance();
  const canonicalTool = canonicalTenantAgenticTool(tool);
  const settings = useAgorStore((state) => state.agenticToolSettingsByName?.get(canonicalTool));
  const inlineAllowed = settings?.inline_configuration_allowed !== false;
  const isClaude = CLAUDE_TOOLS.has(tool);

  const [presets, setPresets] = useState<AgenticToolPreset[]>([]);
  const [loading, setLoading] = useState(true);

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

  // Can the selected source actually resolve to a config? Mirrors the daemon's
  // create logic (assertInlineAgenticConfigurationAllowed / reference resolution).
  const configResolvable = (() => {
    if (loading) return true; // optimistic until presets load
    if (presets.some((preset) => preset.preset_id === source)) return true;
    if (source === USER_DEFAULT_AGENTIC_CONFIGURATION) {
      if (userSelection?.source === 'preset') return true;
      if (userSelection?.source === 'workspace_default') return inlineAllowed || !!workspacePreset;
      return inlineAllowed; // inline user default
    }
    if (source === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION)
      return inlineAllowed || !!workspacePreset;
    return inlineAllowed; // inline / not-yet-resolved source
  })();

  useEffect(() => {
    onConfigValidityChange?.(
      configResolvable,
      configResolvable
        ? undefined
        : 'This agent requires an admin-managed preset, and none is configured for this workspace'
    );
  }, [configResolvable, onConfigValidityChange]);

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
  const resolvedEffort = (isInline ? formEffort : resolved.modelConfig?.effort) ?? DEFAULT_EFFORT;
  const advisorModel = isInline ? formModelConfig?.advisorModel : undefined;
  const mcpCount = formMcp?.length ?? 0;

  // Summary of what "My default" resolves to, for the Select option label.
  const myDefaultSummary = (): string => {
    if (userSelection?.source === 'preset') {
      return presets.find((p) => p.preset_id === userSelection.preset_id)?.name ?? 'preset';
    }
    if (userSelection?.source === 'workspace_default') {
      return workspacePreset?.name ?? 'workspace default';
    }
    return summarize(canonicalTool, userConfigBlob);
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

  const sourceOptions = [
    ...(hasUserDefault
      ? [
          {
            value: USER_DEFAULT_AGENTIC_CONFIGURATION,
            label: `My default${myDefaultSummary() ? ` · ${myDefaultSummary()}` : ''}`,
          },
        ]
      : []),
    {
      value: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
      label: workspacePreset
        ? `Workspace default · ${workspacePreset.name}`
        : 'Workspace default · not configured',
      disabled: !workspacePreset,
    },
    ...presets.map((preset) => ({ value: preset.preset_id as string, label: preset.name })),
    ...(inlineAllowed ? [{ value: INLINE_AGENTIC_CONFIGURATION, label: 'Custom' }] : []),
  ];

  const permissionMeta = getPermissionModeMeta(tool, resolvedPermission);
  const permissionColor =
    permissionMeta?.tone === 'warning' ? getPermissionModeColor('warning', token) : undefined;

  const managedNote = (
    <Typography.Text type="secondary">
      Managed by preset — switch presets to change.
    </Typography.Text>
  );

  return (
    <div style={{ marginBottom: token.marginSM }}>
      {/* Register the fields the chips edit imperatively so useWatch stays reactive. */}
      {['agenticToolPresetId', 'modelConfig', 'permissionMode', 'effort', 'mcpServerIds'].map(
        (name) => (
          <Form.Item key={name} name={name === 'agenticToolPresetId' ? fieldName : name} noStyle>
            <HiddenField />
          </Form.Item>
        )
      )}

      <Form.Item
        label="Configuration"
        tooltip="Presets are admin-managed configs; “My default” is your personal setup. Edit any chip below to override just this session."
        style={{ marginBottom: token.marginSM }}
      >
        <Select
          value={source}
          onChange={onSelectSource}
          loading={loading}
          options={sourceOptions}
          style={{ width: '100%' }}
        />
      </Form.Item>

      <Flex gap={token.marginXS} align="center" wrap="wrap">
        {resolvedModel && (
          <EditableChip
            icon={<RobotOutlined />}
            label={shortModelName(tool, resolvedModel)}
            title="Model"
            editable={inlineAllowed}
            managedNote={managedNote}
            minWidth={360}
            testid="model-chip"
            renderContent={() => (
              <ModelSelector
                value={resolved.modelConfig as ModelConfig | undefined}
                onChange={onModelChange}
                agentic_tool={tool}
                client={client}
                showAdvisor={false}
              />
            )}
          />
        )}

        <EditableChip
          icon={permissionMeta?.icon}
          label={getPermissionModeLabel(tool, resolvedPermission)}
          title="Permission mode"
          editable={inlineAllowed}
          managedNote={managedNote}
          color={permissionColor}
          minWidth={340}
          testid="permission-chip"
          renderContent={(close) => (
            <PermissionModeSelector
              value={resolvedPermission}
              onChange={(mode) => {
                onPermissionChange(mode);
                close();
              }}
              agentic_tool={tool}
              fullWidth
            />
          )}
        />

        {isClaude && (
          <EditableChip
            icon={<ExperimentOutlined />}
            label={`Effort: ${EFFORT_LABELS[resolvedEffort]}`}
            title="Reasoning effort"
            editable={inlineAllowed}
            managedNote={managedNote}
            minWidth={300}
            testid="effort-chip"
            renderContent={(close) => (
              <EffortSelector
                value={resolvedEffort}
                onChange={(effort) => {
                  onEffortChange(effort);
                  close();
                }}
                fullWidth
              />
            )}
          />
        )}

        {/* MCP servers — orthogonal to preset config, always editable; multi-select stays open */}
        <EditableChip
          icon={<ApiOutlined />}
          label={
            mcpCount > 0 ? `${mcpCount} MCP server${mcpCount === 1 ? '' : 's'}` : 'No MCP servers'
          }
          title="MCP servers"
          editable
          minWidth={360}
          testid="mcp-chip"
          renderContent={() => (
            <MCPServerSelect
              mcpServers={mapToArray(mcpServerById)}
              value={formMcp}
              onChange={onMcpChange}
              placeholder="No MCP servers attached"
              style={{ width: '100%' }}
            />
          )}
        />

        {/* Advisor — only meaningful (and applied) while inline config is active */}
        {isClaude && isInline && advisorModel && (
          <EditableChip
            icon={<InfoCircleOutlined />}
            label={`Advisor: ${shortModelName(tool, advisorModel)}`}
            title="Advisor model"
            editable
            minWidth={340}
            testid="advisor-chip"
            renderContent={() => (
              <AdvisorModelSelect value={advisorModel} onChange={onAdvisorChange} client={client} />
            )}
          />
        )}
      </Flex>

      {enableSaveAsDefault && isInline && currentUser && client && (
        <div style={{ marginTop: token.marginSM }}>
          <Form.Item name={SAVE_AS_DEFAULT_FIELD} valuePropName="checked" noStyle>
            <Checkbox>Save as my default for {tool}</Checkbox>
          </Form.Item>
        </div>
      )}
    </div>
  );
};

interface EditableChipProps {
  icon?: React.ReactNode;
  label: string;
  title: string;
  editable: boolean;
  managedNote?: React.ReactNode;
  color?: string;
  minWidth: number;
  testid: string;
  /** Receives a `close` callback so single-value pickers can dismiss on select. */
  renderContent: (close: () => void) => React.ReactNode;
}

/** A Tag chip that opens a popover editor on click (or shows a managed note). */
const EditableChip: React.FC<EditableChipProps> = ({
  icon,
  label,
  title,
  editable,
  managedNote,
  color,
  minWidth,
  testid,
  renderContent,
}) => {
  const [open, setOpen] = useState(false);

  const chip = (
    <Tag
      icon={icon}
      color="default"
      style={{
        cursor: editable ? 'pointer' : 'default',
        height: 22,
        display: 'inline-flex',
        alignItems: 'center',
        color,
      }}
      data-testid={testid}
    >
      {label}
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
      open={open}
      onOpenChange={setOpen}
      trigger="click"
      placement="bottomLeft"
      title={title}
      content={
        <div style={{ minWidth, maxWidth: '90vw' }}>{renderContent(() => setOpen(false))}</div>
      }
    >
      {chip}
    </Popover>
  );
};
