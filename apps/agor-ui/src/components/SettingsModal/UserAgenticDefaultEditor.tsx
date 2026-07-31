import {
  agenticToolRequiresModelSelection,
  getAgenticToolIntegration,
  isAgenticToolModelSelectionComplete,
} from '@agor/agentic-tools';
import type { AgenticToolName, AgorClient } from '@agor-live/client';
import { Alert, Button, Form, Select, Typography } from 'antd';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { useAgenticConfigurationSources } from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';

interface Props {
  tool: AgenticToolName;
  client: AgorClient | null;
  isAdmin: boolean;
}

/** User-level default strategy. Runtime resources resolve this once, then store a concrete selection. */
export const UserAgenticDefaultEditor: React.FC<Props> = ({ tool, client, isAdmin }) => {
  const form = Form.useFormInstance();
  const source = Form.useWatch('defaultSelectionSource', form) ?? 'workspace_default';
  const { presets, inlineAllowed, loaded, loadError, loading, retry } =
    useAgenticConfigurationSources({ tool, client });

  const workspaceDefault = presets.find((preset) => preset.is_default);
  const requiresModelSelection = agenticToolRequiresModelSelection(tool);
  const missingSelectionError = getAgenticToolIntegration(tool).configuration.missingSelectionError;
  const hasCompleteModel = (presetId?: string) => {
    const preset = presets.find((candidate) => candidate.preset_id === presetId);
    return Boolean(
      preset && isAgenticToolModelSelectionComplete(tool, preset.configuration.modelConfig)
    );
  };
  const workspaceDefaultUsable = Boolean(
    workspaceDefault &&
      (!requiresModelSelection ||
        isAgenticToolModelSelectionComplete(tool, workspaceDefault.configuration.modelConfig))
  );

  return (
    <>
      <Form.Item
        name="defaultSelectionSource"
        label="Default for new configurations"
        rules={[
          {
            validator: (_, nextSource) =>
              loaded &&
              !loadError &&
              nextSource === 'workspace_default' &&
              requiresModelSelection &&
              !workspaceDefaultUsable
                ? Promise.reject(new Error(missingSelectionError))
                : Promise.resolve(),
          },
        ]}
      >
        <Select
          loading={loading}
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
          style={{ marginBottom: 16 }}
        />
      )}

      {source === 'workspace_default' && loaded && !workspaceDefaultUsable && (
        <Alert
          type="warning"
          showIcon
          title={
            workspaceDefault
              ? 'The workspace default is incomplete for this tool'
              : 'No workspace default is configured'
          }
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
          rules={[
            { required: true, message: 'Choose a preset' },
            {
              validator: (_, presetId) =>
                loaded &&
                !loadError &&
                requiresModelSelection &&
                presetId &&
                !hasCompleteModel(presetId)
                  ? Promise.reject(new Error(missingSelectionError))
                  : Promise.resolve(),
            },
          ]}
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
