/**
 * Default Agentic Settings Component
 *
 * Allows users to configure default settings for each agentic tool
 * that will be used to prepopulate session creation forms.
 */

import type { AgenticToolName, DefaultAgenticConfig, MCPServer } from '@agor-live/client';
import { Button, Form, Space, Tabs, Typography } from 'antd';
import { useState } from 'react';
import { useThemedMessage } from '../../utils/message';
import {
  AgenticToolConfigForm,
  buildConfigFromFormValues,
  getClearedFormValues,
  getFormValuesFromConfig,
} from '../AgenticToolConfigForm';

interface DefaultAgenticSettingsProps {
  /** Current default agentic config */
  defaultConfig?: DefaultAgenticConfig;
  /** Available MCP servers */
  mcpServerById: Map<string, MCPServer>;
  /** Callback when settings are saved */
  onSave: (config: DefaultAgenticConfig) => Promise<void>;
}

export const DefaultAgenticSettings: React.FC<DefaultAgenticSettingsProps> = ({
  defaultConfig,
  mcpServerById,
  onSave,
}) => {
  const { showSuccess, showError } = useThemedMessage();

  // Separate form for each tool
  const [claudeForm] = Form.useForm();
  const [codexForm] = Form.useForm();
  const [geminiForm] = Form.useForm();
  const [opencodeForm] = Form.useForm();
  const [copilotForm] = Form.useForm();

  const [saving, setSaving] = useState<Record<AgenticToolName, boolean>>({
    'claude-code': false,
    codex: false,
    gemini: false,
    opencode: false,
    copilot: false,
  });
  const [activeTab, setActiveTab] = useState<AgenticToolName>('claude-code');

  const getInitialValues = (tool: AgenticToolName) =>
    getFormValuesFromConfig(tool, defaultConfig?.[tool]);

  const getFormForTool = (tool: AgenticToolName) => {
    switch (tool) {
      case 'claude-code':
        return claudeForm;
      case 'codex':
        return codexForm;
      case 'gemini':
        return geminiForm;
      case 'opencode':
        return opencodeForm;
      case 'copilot':
        return copilotForm;
    }
  };

  const handleSave = async (tool: AgenticToolName) => {
    setSaving((prev) => ({ ...prev, [tool]: true }));
    try {
      const values = getFormForTool(tool).getFieldsValue();
      const newConfig: DefaultAgenticConfig = {
        ...defaultConfig,
        [tool]: buildConfigFromFormValues(tool, values),
      };

      await onSave(newConfig);
      showSuccess(`Default ${tool} settings saved`);
    } catch (error) {
      showError('Failed to save settings');
      console.error('Error saving default agentic settings:', error);
    } finally {
      setSaving((prev) => ({ ...prev, [tool]: false }));
    }
  };

  const handleClear = (tool: AgenticToolName) => {
    getFormForTool(tool).setFieldsValue(getClearedFormValues(tool));
  };

  const tabItems: Array<{
    key: AgenticToolName;
    label: string;
    tool: AgenticToolName;
    form: ReturnType<typeof Form.useForm>[0];
  }> = [
    {
      key: 'claude-code',
      label: 'Claude Code',
      tool: 'claude-code',
      form: claudeForm,
    },
    {
      key: 'codex',
      label: 'Codex',
      tool: 'codex',
      form: codexForm,
    },
    {
      key: 'gemini',
      label: 'Gemini',
      tool: 'gemini',
      form: geminiForm,
    },
    {
      key: 'opencode',
      label: 'OpenCode',
      tool: 'opencode',
      form: opencodeForm,
    },
    {
      key: 'copilot',
      label: 'GitHub Copilot',
      tool: 'copilot',
      form: copilotForm,
    },
  ];

  return (
    <div style={{ paddingTop: 8 }}>
      <Typography.Paragraph type="secondary" style={{ marginBottom: 16 }}>
        Configure default settings for each agentic tool. These settings will be used to prepopulate
        session creation forms, making it faster to create new sessions with your preferred
        configuration.
      </Typography.Paragraph>

      <Tabs
        activeKey={activeTab}
        onChange={(key) => setActiveTab(key as AgenticToolName)}
        items={tabItems.map(({ key, label, tool, form }) => ({
          key,
          label,
          children: (
            <Form
              form={form}
              layout="vertical"
              initialValues={getInitialValues(tool)}
              style={{ paddingTop: 16 }}
            >
              <AgenticToolConfigForm
                agenticTool={tool}
                mcpServerById={mcpServerById}
                showHelpText={false}
              />

              <Space style={{ marginTop: 16 }}>
                <Button onClick={() => handleClear(tool)}>Clear Defaults</Button>
                <Button type="primary" onClick={() => handleSave(tool)} loading={saving[tool]}>
                  Save Defaults
                </Button>
              </Space>
            </Form>
          ),
        }))}
      />
    </div>
  );
};
