import type { AgenticToolName, AgenticToolPreset, AgorClient, MCPServer } from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import { Alert, Form, Select, Spin } from 'antd';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import type { AgenticToolConfigFormProps } from '../AgenticToolConfigForm';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { SessionMcpServersField } from '../MCPServerSelect';

export const INLINE_AGENTIC_CONFIGURATION = '__inline__';

interface Props extends Omit<AgenticToolConfigFormProps, 'agenticTool' | 'client'> {
  tool: AgenticToolName;
  client: AgorClient | null;
  mcpServerById: Map<string, MCPServer>;
  fieldName?: string;
}

/** Tool-scoped preset-or-inline picker shared by every runtime configuration surface. */
export const AgenticToolConfigurationPicker: React.FC<Props> = ({
  tool,
  client,
  mcpServerById,
  fieldName = 'agenticToolPresetId',
  ...formProps
}) => {
  const form = Form.useFormInstance();
  const selected = Form.useWatch(fieldName, form);
  const canonicalTool = tool === 'claude-code-cli' ? 'claude-code' : tool;
  const settings = useAgorStore((state) => state.agenticToolSettingsByName.get(canonicalTool));
  const inlineAllowed = settings?.inline_configuration_allowed !== false;
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
    const validPreset =
      presets.some((preset) => preset.preset_id === selected) ||
      selected === USER_DEFAULT_AGENTIC_CONFIGURATION ||
      selected === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION;
    if (validPreset || (inlineAllowed && selected === INLINE_AGENTIC_CONFIGURATION)) return;
    form.setFieldValue(fieldName, USER_DEFAULT_AGENTIC_CONFIGURATION);
  }, [fieldName, form, inlineAllowed, loading, presets, selected]);

  return (
    <>
      <Form.Item
        name={fieldName}
        label="Configuration"
        rules={[{ required: true, message: 'Choose a preset or inline configuration' }]}
      >
        <Select
          loading={loading}
          notFoundContent={loading ? <Spin size="small" /> : 'No presets'}
          options={[
            { value: USER_DEFAULT_AGENTIC_CONFIGURATION, label: 'Use my default' },
            {
              value: WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
              label: presets.find((preset) => preset.is_default)
                ? `Use workspace default — ${presets.find((preset) => preset.is_default)?.name}`
                : 'Use workspace default — not configured',
              disabled: !presets.some((preset) => preset.is_default),
            },
            ...presets.map((preset) => ({ value: preset.preset_id, label: preset.name })),
            ...(inlineAllowed
              ? [{ value: INLINE_AGENTIC_CONFIGURATION, label: 'Define configuration here' }]
              : []),
          ]}
        />
      </Form.Item>
      {!inlineAllowed && presets.length === 0 && !loading && (
        <Alert type="error" showIcon title="No administrator-managed preset is available" />
      )}
      {selected === INLINE_AGENTIC_CONFIGURATION && (
        <AgenticToolConfigForm agenticTool={tool} client={client} {...formProps} />
      )}
      {selected && selected !== INLINE_AGENTIC_CONFIGURATION && (
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
          description="The concrete preset or inline configuration will be resolved when this is saved."
        />
      )}
      <SessionMcpServersField mcpServerById={mcpServerById} showHelpText={formProps.showHelpText} />
    </>
  );
};
