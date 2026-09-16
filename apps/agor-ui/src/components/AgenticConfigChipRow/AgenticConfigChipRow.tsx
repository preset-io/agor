import {
  AGENTIC_TOOL_CAPABILITIES,
  agenticToolRequiresModelSelection,
  getAgenticToolModelSelectionError,
} from '@agor/agentic-tools';
import { useAgenticToolReasoningEffortLevels } from '@agor/agentic-tools/ui';
import type {
  AgenticToolName,
  AgorClient,
  DefaultAgenticToolConfig,
  EffortLevel,
  MCPServer,
  PermissionMode,
  User,
} from '@agor-live/client';
import { getDefaultModelForTool, getDefaultPermissionMode } from '@agor-live/client';
import {
  ApiOutlined,
  DownOutlined,
  ExperimentOutlined,
  InfoCircleOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Button,
  Checkbox,
  Collapse,
  Flex,
  Form,
  Popover,
  Select,
  Space,
  Typography,
  theme,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import {
  INLINE_AGENTIC_CONFIGURATION,
  SAVE_AS_DEFAULT_FIELD,
} from '../AgenticToolConfigurationPicker';
import { useAgenticConfigurationSources } from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
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

export interface AgenticConfigChipRowProps {
  tool: AgenticToolName;
  client: AgorClient | null;
  mcpServerById: Map<string, MCPServer>;
  currentUser?: User | null;
  branchId?: string;
  catalogEnabled?: boolean;
  /** Require integration-owned exact model selection on direct create/edit surfaces. */
  validateModelSelection?: boolean;
  /** Form field holding the configuration source. */
  fieldName?: string;
  /** Offer "Save as my default" under the chips while Custom is active. */
  enableSaveAsDefault?: boolean;
  /** Hide effort where changes cannot affect the active runtime. */
  showEffort?: boolean;
  /**
   * Tuck the chip row into a disclosure that starts collapsed, showing a
   * single-line summary of the resolved values. Keeps the "Configuration"
   * select visible. Opt-in for tight surfaces like the navbar composer.
   */
  collapsibleChips?: boolean;
  /**
   * Reports the same source validity enforced by the registered form field so
   * callers can disable submission proactively. `reason` explains why.
   */
  onConfigValidityChange?: (valid: boolean, reason?: string) => void;
  /**
   * Optional field rendered left of the "Configuration" select, sharing a 50/50
   * row. Chips still render full-width below. Omit for the default stacked layout.
   */
  leadingField?: React.ReactNode;
}

const EFFORT_LABELS: Record<EffortLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'X-High',
  max: 'Max',
};

const CLAUDE_TOOLS = new Set<AgenticToolName>(['claude-code']);

/**
 * Renders nothing but lets a `Form.Item` register a field so `Form.useWatch`
 * stays reactive to `setFieldValue` (the chips edit values imperatively rather
 * than through mounted controls).
 */
const HiddenField: React.FC<{ value?: unknown; onChange?: (value: unknown) => void }> = () => null;

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
  branchId,
  catalogEnabled = true,
  validateModelSelection = false,
  fieldName = 'agenticToolPresetId',
  enableSaveAsDefault = false,
  showEffort = true,
  collapsibleChips = false,
  onConfigValidityChange,
  leadingField,
}) => {
  const { token } = theme.useToken();
  const form = Form.useFormInstance();
  const isClaude = CLAUDE_TOOLS.has(tool);
  const toolCapabilities = AGENTIC_TOOL_CAPABILITIES[tool];
  const toolEffortLevels = toolCapabilities.reasoningEffortLevels;
  const supportsEffort = showEffort && Boolean(toolEffortLevels?.length);
  const {
    inlineAllowed,
    loading,
    loaded,
    loadError,
    retry,
    resolveConfiguration,
    isValidSource,
    preferredSource,
    sourceOptions,
    getSourceError,
  } = useAgenticConfigurationSources({ tool, client, currentUser });

  const source = Form.useWatch(fieldName, form) as string | undefined;
  const formModelConfig = Form.useWatch('modelConfig', form) as ModelConfig | undefined;
  const formEffort = Form.useWatch('effort', form) as EffortLevel | undefined;
  const formPermission = Form.useWatch('permissionMode', form) as PermissionMode | undefined;
  const formMcp = Form.useWatch('mcpServerIds', form) as string[] | undefined;

  const isInline = source === INLINE_AGENTIC_CONFIGURATION;

  // Normalize only after a successful load. A transient service failure must
  // never rewrite a stored preset/default while an unrelated setting is saved.
  useEffect(() => {
    if (!loaded || isValidSource(source)) return;
    form.setFieldValue(fieldName, preferredSource);
  }, [fieldName, form, isValidSource, loaded, preferredSource, source]);

  const configForSource = (src: string | undefined): DefaultAgenticToolConfig => {
    return resolveConfiguration(src, {
      modelConfig: formModelConfig,
      permissionMode: formPermission,
    });
  };

  const resolved = configForSource(source);
  const resolvedModelConfig = resolved.modelConfig as ModelConfig | undefined;
  const modelEffortLevels = useAgenticToolReasoningEffortLevels({
    tool,
    selection:
      resolvedModelConfig?.provider && resolvedModelConfig.model
        ? { provider: resolvedModelConfig.provider, model: resolvedModelConfig.model }
        : undefined,
    client,
    branchId,
    catalogEnabled,
  });
  const modelEffortMetadataKnown = tool === 'opencode' && modelEffortLevels !== undefined;
  const effortLevels = modelEffortMetadataKnown ? modelEffortLevels : toolEffortLevels;
  const modelSelectionError = validateModelSelection
    ? getAgenticToolModelSelectionError(tool, resolvedModelConfig)
    : undefined;
  const resolvedModel = resolved.modelConfig?.model || getDefaultModelForTool(tool) || '';
  const resolvedPermission = resolved.permissionMode || getDefaultPermissionMode(tool);
  const explicitEffort = isInline ? formEffort : resolved.modelConfig?.effort;
  const effortSelectionError =
    modelEffortMetadataKnown && explicitEffort && !modelEffortLevels.includes(explicitEffort)
      ? modelEffortLevels.length > 0
        ? `Choose a supported effort: ${modelEffortLevels.join(', ')}`
        : 'This model has no explicit effort in the configured OpenCode runtime; use inherited.'
      : undefined;
  const configError = getSourceError(source) ?? modelSelectionError ?? effortSelectionError;
  const configResolvable = !configError;
  const correctionError = modelSelectionError ?? effortSelectionError;
  const [chipsExpanded, setChipsExpanded] = useState(false);
  const disclosureExpanded = Boolean(correctionError) || chipsExpanded;

  // Invalid model/effort configuration forces the corrective controls open.
  // Latch that open state so an automatic suggestion or user correction does
  // not make the controls disappear as soon as the error clears.
  useEffect(() => {
    if (correctionError) setChipsExpanded(true);
  }, [correctionError]);

  useEffect(() => {
    onConfigValidityChange?.(configResolvable, configError);
  }, [configError, configResolvable, onConfigValidityChange]);

  const resolvedEffort = explicitEffort ?? toolCapabilities.defaultReasoningEffort;
  const advisorModel = resolved.modelConfig?.advisorModel;
  const mcpCount = formMcp?.length ?? 0;
  const requiresModelSelection = agenticToolRequiresModelSelection(tool);

  // Chip labels, also composed into the collapsed one-line summary so the two
  // can never drift apart.
  const showModelChip = Boolean(resolvedModel) || requiresModelSelection;
  const modelLabel = requiresModelSelection
    ? resolvedModelConfig?.provider && resolvedModel
      ? `${resolvedModelConfig.provider}/${resolvedModel}`
      : 'Select provider/model'
    : shortModelName(tool, resolvedModel);
  const permissionLabel = getPermissionModeLabel(tool, resolvedPermission);
  const effortLabel = `Effort: ${resolvedEffort ? EFFORT_LABELS[resolvedEffort] : 'Inherited'}`;
  const mcpLabel =
    mcpCount > 0 ? `${mcpCount} MCP server${mcpCount === 1 ? '' : 's'}` : 'No MCP servers';
  const advisorLabel = advisorModel
    ? `Advisor: ${shortModelName(tool, advisorModel)}`
    : 'Advisor: Off';

  const chipSummary = [
    showModelChip ? modelLabel : null,
    permissionLabel,
    supportsEffort ? effortLabel : null,
    mcpLabel,
    isClaude ? advisorLabel : null,
  ]
    .filter(Boolean)
    .join(' · ');

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
  const onEffortChange = (effort: EffortLevel | undefined) => {
    ensureCustom();
    form.setFieldValue('effort', effort);
  };
  const onAdvisorChange = (advisor: string | undefined) => {
    ensureCustom();
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

  const permissionMeta = getPermissionModeMeta(tool, resolvedPermission);
  const permissionColor =
    permissionMeta?.tone === 'warning' ? getPermissionModeColor('warning', token) : undefined;
  const modelEffortAvailabilityRef = useRef<
    | {
        provider: string;
        model: string;
        levels: readonly EffortLevel[] | undefined;
      }
    | undefined
  >(undefined);

  const managedNote = (
    <Typography.Text type="secondary">
      Managed by preset — switch presets to change.
    </Typography.Text>
  );

  const configField = (
    <Form.Item
      name={fieldName}
      label="Configuration"
      tooltip="Presets are admin-managed configs; “My default” is your personal setup. Edit any chip below to override just this session."
      style={{ marginBottom: token.marginSM }}
      rules={[
        {
          validator: () =>
            configError ? Promise.reject(new Error(configError)) : Promise.resolve(),
        },
      ]}
    >
      <Select
        onChange={onSelectSource}
        loading={loading}
        options={sourceOptions.map((option) => ({
          value: option.value,
          disabled: option.disabled,
          label:
            option.value === INLINE_AGENTIC_CONFIGURATION
              ? 'Custom'
              : option.summary
                ? `${option.title} · ${option.summary}`
                : option.title,
        }))}
        style={{ width: '100%' }}
      />
    </Form.Item>
  );

  const chipRow = (
    <Flex gap={token.marginXS} align="center" wrap="wrap">
      {showModelChip && (
        <EditableChip
          icon={<RobotOutlined />}
          label={modelLabel}
          title="Model"
          editable={inlineAllowed}
          managedNote={managedNote}
          width={440}
          testid="model-chip"
          renderContent={(close) => (
            <ModelSelector
              value={resolved.modelConfig as ModelConfig | undefined}
              onChange={onModelChange}
              agentic_tool={tool}
              client={client}
              branchId={branchId}
              catalogEnabled={catalogEnabled}
              showAdvisor={false}
              onReasoningEffortLevelsChange={(availability) => {
                modelEffortAvailabilityRef.current = availability;
              }}
              onCommit={(next) => {
                const availability = modelEffortAvailabilityRef.current;
                const currentEffort = form.getFieldValue('effort') as EffortLevel | undefined;
                if (
                  tool === 'opencode' &&
                  currentEffort &&
                  availability !== undefined &&
                  availability.provider === next.provider &&
                  availability.model === next.model &&
                  availability.levels !== undefined &&
                  !availability.levels.includes(currentEffort)
                ) {
                  form.setFieldValue('effort', undefined);
                }
                close();
              }}
            />
          )}
        />
      )}

      <EditableChip
        icon={permissionMeta?.icon}
        label={permissionLabel}
        title="Permission mode"
        editable={inlineAllowed}
        managedNote={managedNote}
        color={permissionColor}
        width={340}
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

      {supportsEffort && (
        <EditableChip
          icon={<ExperimentOutlined />}
          label={effortLabel}
          title="Reasoning effort"
          editable={inlineAllowed}
          managedNote={managedNote}
          color={effortSelectionError ? token.colorError : undefined}
          width={300}
          testid="effort-chip"
          renderContent={(close) => (
            <Space orientation="vertical" size={8} style={{ width: '100%' }}>
              {tool === 'opencode' &&
                modelEffortMetadataKnown &&
                modelEffortLevels.length === 0 && (
                  <Typography.Text type={effortSelectionError ? 'danger' : 'secondary'}>
                    This model has no explicit effort in the configured OpenCode runtime. Use
                    inherited.
                  </Typography.Text>
                )}
              {tool === 'opencode' && !modelEffortMetadataKnown && (
                <Typography.Text type="secondary">
                  Available efforts are unknown for this exact model and will be validated at
                  runtime.
                </Typography.Text>
              )}
              <EffortSelector
                value={resolvedEffort}
                levels={effortLevels}
                fallbackValue={toolCapabilities.defaultReasoningEffort}
                allowInherited={!toolCapabilities.defaultReasoningEffort}
                onChange={(effort) => {
                  onEffortChange(effort);
                  close();
                }}
                fullWidth
              />
            </Space>
          )}
        />
      )}

      {/* MCP servers — orthogonal to preset config, always editable; multi-select stays open */}
      <EditableChip
        icon={<ApiOutlined />}
        label={mcpLabel}
        title="MCP servers"
        editable
        width={360}
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

      {/* Advisor — applied from any source, so it must stay clearable from any source */}
      {isClaude && (
        <EditableChip
          icon={<InfoCircleOutlined />}
          label={advisorLabel}
          title="Advisor model"
          editable={inlineAllowed}
          managedNote={managedNote}
          width={340}
          testid="advisor-chip"
          renderContent={(close) => (
            <AdvisorModelSelect
              value={advisorModel}
              onChange={(next) => {
                onAdvisorChange(next);
                close();
              }}
              client={client}
            />
          )}
        />
      )}
    </Flex>
  );

  return (
    <div style={{ marginBottom: collapsibleChips ? token.marginSM : token.marginLG }}>
      {/* Register the fields the chips edit imperatively so useWatch stays reactive. */}
      {['modelConfig', 'permissionMode', 'effort', 'mcpServerIds'].map((name) => (
        <Form.Item key={name} name={name} noStyle>
          <HiddenField />
        </Form.Item>
      ))}

      {leadingField ? (
        <Flex gap={token.marginSM} align="flex-start">
          <div style={{ flex: '1 1 0', minWidth: 0 }}>{leadingField}</div>
          <div style={{ flex: '1 1 0', minWidth: 0 }}>{configField}</div>
        </Flex>
      ) : (
        configField
      )}

      {loadError && (
        <Alert
          type="error"
          showIcon
          title="Unable to load configuration presets"
          action={
            <Button size="small" onClick={retry}>
              Retry
            </Button>
          }
          style={{ marginBottom: token.marginSM }}
        />
      )}

      {collapsibleChips ? (
        <Collapse
          ghost
          destroyOnHidden={false}
          activeKey={disclosureExpanded ? ['chips'] : []}
          onChange={(activeKeys) => {
            // AntD may still report a requested key change for a disabled
            // header. Keep the forced-open latch intact until the invalid
            // model/effort selection is corrected.
            if (correctionError) return;
            const keys = Array.isArray(activeKeys) ? activeKeys : [activeKeys];
            setChipsExpanded(keys.includes('chips'));
          }}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          // Flush the caret to the column's left edge, center it against the
          // single-line summary, and tighten the header's block padding so the
          // collapsed summary sits close to the textarea.
          styles={{
            header: {
              alignItems: 'center',
              paddingInlineStart: 0,
              paddingBlock: token.paddingXXS,
            },
            title: { flex: 1, minWidth: 0 },
          }}
          items={[
            {
              key: 'chips',
              collapsible: correctionError ? 'disabled' : 'header',
              label: (
                <Typography.Text
                  aria-label={`Session configuration: ${chipSummary}${
                    modelSelectionError
                      ? '. Complete the required model selection before collapsing.'
                      : effortSelectionError
                        ? '. Correct the invalid reasoning effort before collapsing.'
                        : ''
                  }`}
                  type="secondary"
                  ellipsis={{ tooltip: chipSummary }}
                  style={{ display: 'block', fontSize: token.fontSizeSM, minWidth: 0 }}
                >
                  {chipSummary}
                </Typography.Text>
              ),
              children: chipRow,
            },
          ]}
        />
      ) : (
        chipRow
      )}

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
  width: number;
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
  width,
  testid,
  renderContent,
}) => {
  const { token } = theme.useToken();
  const [open, setOpen] = useState(false);

  const chip = (
    <Button
      htmlType="button"
      size="small"
      icon={icon}
      style={{
        color,
      }}
      data-testid={testid}
      aria-label={`${title}: ${label}`}
      aria-expanded={open}
    >
      {label}
    </Button>
  );

  if (!editable) {
    return (
      <Popover
        open={open}
        onOpenChange={setOpen}
        trigger="click"
        placement="bottomLeft"
        title={title}
        content={managedNote}
      >
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
        <div style={{ width, maxWidth: `calc(100vw - ${token.marginLG * 2}px)` }}>
          {renderContent(() => setOpen(false))}
        </div>
      }
    >
      {chip}
    </Popover>
  );
};
