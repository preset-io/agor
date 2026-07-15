import type {
  AgenticToolName,
  AgenticToolPreset,
  AgorClient,
  DefaultAgenticToolConfig,
  MCPServer,
  User,
} from '@agor-live/client';
import {
  canonicalTenantAgenticTool,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Checkbox, Form, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import type { AgenticFormValues, AgenticToolConfigFormProps } from '../AgenticToolConfigForm';
import { AgenticToolConfigForm, buildConfigFromFormValues } from '../AgenticToolConfigForm';
import { SessionMcpServersField } from '../MCPServerSelect';
import { getModelDisplayName } from '../ModelSelector';
import { getPermissionModeLabel } from '../PermissionModeSelector';

export const INLINE_AGENTIC_CONFIGURATION = '__inline__';

/** Form field the save-as-default checkbox binds to. Parents read it on submit. */
export const SAVE_AS_DEFAULT_FIELD = 'saveAsDefault';

interface Props extends Omit<AgenticToolConfigFormProps, 'agenticTool' | 'client'> {
  tool: AgenticToolName;
  client: AgorClient | null;
  mcpServerById: Map<string, MCPServer>;
  fieldName?: string;
  /**
   * How a reserved default/preset resolves — surfaced as a schedule-run note.
   * `save` (default) shows no banner (the redesign relies on inline resolved
   * summaries); `schedule-run` explains per-run resolution for ScheduleModal.
   */
  defaultResolution?: 'save' | 'schedule-run';
  /** Current user — resolves "My default" and gates the save-as-default checkbox. */
  currentUser?: User | null;
  /** Render the MCP servers field inside the picker (default true). */
  renderMcpField?: boolean;
  /** Offer the "Save as my default" checkbox while inline config is active. */
  enableSaveAsDefault?: boolean;
}

/** One-line "Model · Permission" summary of a concrete config for inline display. */
function summarizeConfig(tool: AgenticToolName, config?: DefaultAgenticToolConfig): string {
  if (!config) return '';
  const parts: string[] = [];
  if (config.modelConfig?.model) parts.push(getModelDisplayName(tool, config.modelConfig.model));
  if (config.permissionMode) parts.push(getPermissionModeLabel(tool, config.permissionMode));
  return parts.join(' · ');
}

/**
 * Persist an inline configuration as the user's default for a tool. Callers
 * invoke this from their own submit handler when the save-as-default checkbox
 * is checked, then create/update the session as usual.
 *
 * Writes under the canonical tool key (claude-code-cli → claude-code, matching
 * the daemon resolver) and also sets `default_agentic_selection[tool]` to
 * `{ source: 'inline' }` — otherwise a user whose selection points at a preset
 * or the workspace default would save a config blob the daemon never resolves.
 */
export async function persistUserDefaultFromForm(
  client: AgorClient,
  user: User,
  tool: AgenticToolName,
  values: AgenticFormValues
): Promise<void> {
  const canonical = canonicalTenantAgenticTool(tool);
  const config = buildConfigFromFormValues(canonical, values);
  await client.service('users').patch(user.user_id, {
    default_agentic_config: { ...user.default_agentic_config, [canonical]: config },
    default_agentic_selection: {
      ...user.default_agentic_selection,
      [canonical]: { source: 'inline' as const },
    },
  });
}

/** Tool-scoped preset-or-inline picker shared by every runtime configuration surface. */
export const AgenticToolConfigurationPicker: React.FC<Props> = ({
  tool,
  client,
  mcpServerById,
  fieldName = 'agenticToolPresetId',
  defaultResolution = 'save',
  currentUser,
  renderMcpField = true,
  enableSaveAsDefault = false,
  ...formProps
}) => {
  const form = Form.useFormInstance();
  const selected = Form.useWatch(fieldName, form);
  // Canonicalize the tool key exactly as the daemon does (claude-code-cli →
  // claude-code) so defaults read/write under one key across both surfaces.
  const canonicalTool = canonicalTenantAgenticTool(tool);
  const settings = useAgorStore((state) => state.agenticToolSettingsByName.get(canonicalTool));
  const inlineAllowed = settings?.inline_configuration_allowed !== false;
  const [presets, setPresets] = useState<AgenticToolPreset[]>([]);
  const [loading, setLoading] = useState(true);

  const workspacePreset = presets.find((preset) => preset.is_default);

  // The daemon resolves the user default from `default_agentic_selection` first
  // (preset / workspace_default / inline), falling back to the config blob. Mirror
  // that here so a preset- or workspace-backed default is still surfaced as
  // "My default" and reachable — not hidden and force-switched to inline.
  const userSelection = currentUser?.default_agentic_selection?.[canonicalTool];
  const userConfigBlob = currentUser?.default_agentic_config?.[canonicalTool];
  // When no user is provided the picker can't know whether a default exists, so
  // it preserves the legacy "My default" option.
  const hasUserDefault = currentUser ? Boolean(userSelection ?? userConfigBlob) : true;

  const myDefaultSummary = (): string => {
    if (userSelection?.source === 'preset') {
      const preset = presets.find((p) => p.preset_id === userSelection.preset_id);
      if (!preset) return 'preset';
      const summary = summarizeConfig(canonicalTool, preset.configuration);
      return summary ? `${preset.name} · ${summary}` : preset.name;
    }
    if (userSelection?.source === 'workspace_default') {
      return workspacePreset ? `Workspace default · ${workspacePreset.name}` : 'Workspace default';
    }
    return summarizeConfig(canonicalTool, userConfigBlob);
  };

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
        .then((result) => {
          if (active) setPresets(Array.isArray(result) ? result : result.data);
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

  useEffect(() => {
    if (loading) return;
    const validSelection =
      presets.some((preset) => preset.preset_id === selected) ||
      (selected === USER_DEFAULT_AGENTIC_CONFIGURATION && hasUserDefault) ||
      selected === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION ||
      (inlineAllowed && selected === INLINE_AGENTIC_CONFIGURATION);
    if (validSelection) return;
    // No stored default → don't fabricate one; start from an editable config.
    const preferred = hasUserDefault
      ? USER_DEFAULT_AGENTIC_CONFIGURATION
      : inlineAllowed
        ? INLINE_AGENTIC_CONFIGURATION
        : WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION;
    form.setFieldValue(fieldName, preferred);
  }, [fieldName, form, hasUserDefault, inlineAllowed, loading, presets, selected]);

  const options: Array<{
    value: string;
    label: React.ReactNode;
    title: string;
    summary: string;
    disabled?: boolean;
  }> = [];

  if (hasUserDefault) {
    options.push({
      value: USER_DEFAULT_AGENTIC_CONFIGURATION,
      title: 'My default',
      summary: myDefaultSummary(),
      label: 'My default',
    });
  }
  options.push({
    value: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
    title: workspacePreset ? `Workspace default · ${workspacePreset.name}` : 'Workspace default',
    summary: workspacePreset
      ? summarizeConfig(canonicalTool, workspacePreset.configuration)
      : 'not configured',
    label: workspacePreset ? `Workspace default · ${workspacePreset.name}` : 'Workspace default',
    disabled: !workspacePreset,
  });
  for (const preset of presets) {
    options.push({
      value: preset.preset_id,
      title: preset.name,
      summary: summarizeConfig(canonicalTool, preset.configuration),
      label: preset.name,
    });
  }
  if (inlineAllowed) {
    options.push({
      value: INLINE_AGENTIC_CONFIGURATION,
      title: 'Customize for this session…',
      summary: '',
      label: 'Customize for this session…',
    });
  }

  const configurationLabel = (
    <Space size={4}>
      <span>Configuration</span>
      <Tooltip title="Presets are admin-managed configs. “My default” is your personal setup applied to new sessions.">
        <InfoCircleOutlined />
      </Tooltip>
    </Space>
  );

  return (
    <>
      <Form.Item
        name={fieldName}
        label={configurationLabel}
        rules={[{ required: true, message: 'Choose a preset or inline configuration' }]}
      >
        <Select
          loading={loading}
          notFoundContent={loading ? <Spin size="small" /> : 'No presets'}
          optionLabelProp="labelText"
          options={options.map((option) => ({
            value: option.value,
            disabled: option.disabled,
            // Closed control carries the resolved summary — this replaces the banner.
            labelText: option.summary ? `${option.title} · ${option.summary}` : option.title,
            title: option.title,
            summary: option.summary,
          }))}
          optionRender={(option) => (
            <div style={{ lineHeight: 1.3 }}>
              <div>{option.data.title}</div>
              {option.data.summary && (
                <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                  {option.data.summary}
                </Typography.Text>
              )}
            </div>
          )}
        />
      </Form.Item>

      {!inlineAllowed && presets.length === 0 && !loading && (
        <Alert type="error" showIcon title="No administrator-managed preset is available" />
      )}

      {/* Schedules resolve reserved defaults/presets at each run — keep #1963's
          per-run note. Save-context surfaces rely on the inline resolved
          summaries instead of a banner (WS3 redesign). */}
      {defaultResolution === 'schedule-run' &&
        selected &&
        selected !== INLINE_AGENTIC_CONFIGURATION && (
          <Alert
            type="info"
            showIcon
            title={
              selected === USER_DEFAULT_AGENTIC_CONFIGURATION
                ? 'Using your default'
                : selected === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
                  ? 'Using the workspace default'
                  : 'Managed by preset'
            }
            description={
              selected === USER_DEFAULT_AGENTIC_CONFIGURATION
                ? "Resolved from the schedule creator's current default each time this schedule runs."
                : selected === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
                  ? 'Resolved from the current workspace default each time this schedule runs.'
                  : 'The latest version of this preset is used each time this schedule runs.'
            }
          />
        )}

      {selected === INLINE_AGENTIC_CONFIGURATION && (
        <>
          <AgenticToolConfigForm agenticTool={tool} client={client} {...formProps} />
          {enableSaveAsDefault && currentUser && client && (
            <Form.Item
              name={SAVE_AS_DEFAULT_FIELD}
              valuePropName="checked"
              style={{ marginBottom: 8 }}
            >
              <Checkbox>Save as my default for {tool}</Checkbox>
            </Form.Item>
          )}
        </>
      )}

      {renderMcpField && (
        <SessionMcpServersField
          mcpServerById={mcpServerById}
          showHelpText={formProps.showHelpText}
        />
      )}
    </>
  );
};
