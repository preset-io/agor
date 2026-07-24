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
  ExperimentOutlined,
  InfoCircleOutlined,
  RobotOutlined,
} from '@ant-design/icons';
import { Alert, Button, Checkbox, Flex, Form, Popover, Select, Typography, theme } from 'antd';
import { useEffect, useState } from 'react';
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
  /** Form field holding the configuration source. */
  fieldName?: string;
  /** Offer "Save as my default" under the chips while Custom is active. */
  enableSaveAsDefault?: boolean;
  /**
   * Reports the same source validity enforced by the registered form field so
   * callers can disable submission proactively. `reason` explains why.
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
  const isClaude = CLAUDE_TOOLS.has(tool);
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

  const configError = getSourceError(source);
  const configResolvable = !configError;

  useEffect(() => {
    onConfigValidityChange?.(configResolvable, configError);
  }, [configError, configResolvable, onConfigValidityChange]);

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
  const resolvedModel = resolved.modelConfig?.model || getDefaultModelForTool(tool) || '';
  const resolvedPermission = resolved.permissionMode || getDefaultPermissionMode(tool);
  const resolvedEffort = (isInline ? formEffort : resolved.modelConfig?.effort) ?? DEFAULT_EFFORT;
  const advisorModel = isInline ? formModelConfig?.advisorModel : undefined;
  const mcpCount = formMcp?.length ?? 0;

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

  const permissionMeta = getPermissionModeMeta(tool, resolvedPermission);
  const permissionColor =
    permissionMeta?.tone === 'warning' ? getPermissionModeColor('warning', token) : undefined;

  const managedNote = (
    <Typography.Text type="secondary">
      Managed by preset — switch presets to change.
    </Typography.Text>
  );

  return (
    <div style={{ marginBottom: token.marginLG }}>
      {/* Register the fields the chips edit imperatively so useWatch stays reactive. */}
      {['modelConfig', 'permissionMode', 'effort', 'mcpServerIds'].map((name) => (
        <Form.Item key={name} name={name} noStyle>
          <HiddenField />
        </Form.Item>
      ))}

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

      <Flex gap={token.marginXS} align="center" wrap="wrap">
        {resolvedModel && (
          <EditableChip
            icon={<RobotOutlined />}
            label={shortModelName(tool, resolvedModel)}
            title="Model"
            editable={inlineAllowed}
            managedNote={managedNote}
            width={440}
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

        {isClaude && (
          <EditableChip
            icon={<ExperimentOutlined />}
            label={`Effort: ${EFFORT_LABELS[resolvedEffort]}`}
            title="Reasoning effort"
            editable={inlineAllowed}
            managedNote={managedNote}
            width={300}
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

        {/* Advisor — only meaningful (and applied) while inline config is active */}
        {isClaude && isInline && (
          <EditableChip
            icon={<InfoCircleOutlined />}
            label={advisorModel ? `Advisor: ${shortModelName(tool, advisorModel)}` : 'Advisor: Off'}
            title="Advisor model"
            editable
            width={340}
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
