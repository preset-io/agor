import type { AgenticToolName, AgorClient, MCPServer, User } from '@agor-live/client';
import { InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Button, Checkbox, Form, Select, Space, Spin, Tooltip, Typography } from 'antd';
import { useEffect } from 'react';
import type { AgenticFormValues, AgenticToolConfigFormProps } from '../AgenticToolConfigForm';
import { AgenticToolConfigForm, buildConfigFromFormValues } from '../AgenticToolConfigForm';
import { SessionMcpServersField } from '../MCPServerSelect';
import {
  INLINE_AGENTIC_CONFIGURATION,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  useAgenticConfigurationSources,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from './useAgenticConfigurationSources';

export { INLINE_AGENTIC_CONFIGURATION } from './useAgenticConfigurationSources';

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

/**
 * Persist an inline configuration as the user's default for a tool. Callers
 * invoke this from their own submit handler when the save-as-default checkbox
 * is checked, then create/update the session as usual.
 *
 * Writes under the selected tool key and also sets
 * `default_agentic_selection[tool]` to
 * `{ source: 'inline' }` — otherwise a user whose selection points at a preset
 * or the workspace default would save a config blob the daemon never resolves.
 * The daemon reads this raw key before falling back to the canonical tool key.
 */
export async function persistUserDefaultFromForm(
  client: AgorClient,
  user: User,
  tool: AgenticToolName,
  values: AgenticFormValues
): Promise<void> {
  const config = buildConfigFromFormValues(tool, values);
  await client.service('users').patch(user.user_id, {
    default_agentic_config: { ...user.default_agentic_config, [tool]: config },
    default_agentic_selection: {
      ...user.default_agentic_selection,
      [tool]: { source: 'inline' as const },
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
  const {
    inlineAllowed,
    presets,
    loading,
    loaded,
    loadError,
    retry,
    isValidSource,
    preferredSource,
    sourceOptions,
    getSourceError,
  } = useAgenticConfigurationSources({ tool, client, currentUser });

  useEffect(() => {
    if (!loaded || isValidSource(selected)) return;
    form.setFieldValue(fieldName, preferredSource);
  }, [fieldName, form, isValidSource, loaded, preferredSource, selected]);

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
        rules={[
          {
            validator: () => {
              const error = getSourceError(selected);
              return error ? Promise.reject(new Error(error)) : Promise.resolve();
            },
          },
        ]}
      >
        <Select
          loading={loading}
          notFoundContent={loading ? <Spin size="small" /> : 'No presets'}
          optionLabelProp="labelText"
          options={sourceOptions.map((option) => ({
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
        />
      )}

      {!inlineAllowed && presets.length === 0 && loaded && (
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
