import type { AgenticToolName, AgenticToolPreset, AgorClient } from '@agor-live/client';
import { Alert, Form, Select, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';

interface Props {
  tool: AgenticToolName;
  client: AgorClient | null;
  isAdmin: boolean;
}

/** User-level default strategy. Runtime resources resolve this once, then store a concrete selection. */
export const UserAgenticDefaultEditor: React.FC<Props> = ({ tool, client, isAdmin }) => {
  const form = Form.useFormInstance();
  const source = Form.useWatch('defaultSelectionSource', form) ?? 'workspace_default';
  const [presets, setPresets] = useState<AgenticToolPreset[]>([]);
  const canonicalTool = tool === 'claude-code-cli' ? 'claude-code' : tool;
  const settings = useAgorStore((state) => state.agenticToolSettingsByName.get(canonicalTool));
  const inlineAllowed = settings?.inline_configuration_allowed !== false;

  useEffect(() => {
    if (!client) return;
    let active = true;
    void client
      .service('agentic-tool-presets')
      .find({ query: { tool: canonicalTool } })
      .then((result) => {
        if (active) setPresets(Array.isArray(result) ? result : result.data);
      });
    return () => {
      active = false;
    };
  }, [canonicalTool, client]);

  const workspaceDefault = presets.find((preset) => preset.is_default);

  return (
    <>
      <Form.Item name="defaultSelectionSource" label="Default for new configurations">
        <Select
          options={[
            {
              value: 'workspace_default',
              label: workspaceDefault
                ? `Use workspace default — ${workspaceDefault.name}`
                : 'Use workspace default — not configured',
            },
            { value: 'preset', label: 'Use a specific preset', disabled: presets.length === 0 },
            {
              value: 'inline',
              label: 'Define my own configuration',
              disabled: !inlineAllowed,
            },
          ]}
        />
      </Form.Item>

      {source === 'workspace_default' && !workspaceDefault && (
        <Alert
          type="warning"
          showIcon
          title="No workspace default is configured"
          description={
            isAdmin
              ? 'Create a preset and mark it as the default in Workspace Settings → Agentic Tools.'
              : 'Choose another option or ask a workspace administrator to configure a default.'
          }
          style={{ marginBottom: 16 }}
        />
      )}

      {source === 'preset' && (
        <Form.Item
          name="defaultPresetId"
          label="Preset"
          rules={[{ required: true, message: 'Choose a preset' }]}
        >
          <Select
            options={presets.map((preset) => ({ value: preset.preset_id, label: preset.name }))}
          />
        </Form.Item>
      )}

      {source === 'inline' ? (
        <AgenticToolConfigForm agenticTool={tool} showHelpText={false} client={client} />
      ) : (
        <Typography.Paragraph type="secondary">
          New resources resolve this choice when they are created. Existing sessions, schedules, and
          gateway channels are not rewritten.
        </Typography.Paragraph>
      )}
    </>
  );
};
