/**
 * Modal for forking or spawning sessions
 *
 * Prompts user for initial prompt text and calls fork/spawn action
 * For spawn: includes configuration options (agent, callback, etc.)
 */

import type {
  AgenticToolName,
  AgorClient,
  MCPServer,
  Session,
  SpawnConfig,
  User,
} from '@agor-live/client';
import { getDefaultPermissionMode } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Checkbox, Collapse, Form, Modal, Radio, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../AgentSelectionGrid/AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import { AutocompleteTextarea } from '../AutocompleteTextarea';

export type ForkSpawnAction = 'fork' | 'spawn';

export interface ForkSpawnModalProps {
  open: boolean;
  action: ForkSpawnAction;
  session: Session | null;
  currentUser?: User | null;
  mcpServerById?: Map<string, MCPServer>;
  initialPrompt?: string;
  onConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  onCancel: () => void;
  client: AgorClient | null;
  userById: Map<string, User>;
}

export const ForkSpawnModal: React.FC<ForkSpawnModalProps> = ({
  open,
  action,
  session,
  currentUser = null,
  mcpServerById = new Map(),
  initialPrompt = '',
  onConfirm,
  onCancel,
  client,
  userById,
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [configPreset, setConfigPreset] = useState<'parent' | 'custom'>('parent');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>(
    session?.agentic_tool || 'claude-code'
  );

  // Reset form and preset when modal opens
  useEffect(() => {
    if (open && session) {
      setConfigPreset('parent');
      const agentTool = session.agentic_tool || 'claude-code';
      form.setFieldsValue({
        prompt: initialPrompt,
        enableCallback: session.callback_config?.enabled,
        includeLastMessage: session.callback_config?.include_last_message,
        includeOriginalPrompt: session.callback_config?.include_original_prompt,
      });
      setSelectedAgent(agentTool);
    }
  }, [open, session, form, initialPrompt]);

  // When switching to "Custom config", load user defaults for non-prompt fields
  useEffect(() => {
    if (!open || !session || configPreset !== 'custom') return;
    const agentTool = session.agentic_tool || 'claude-code';
    const userDefaults = currentUser?.default_agentic_config?.[agentTool];
    form.setFieldsValue({
      agent: agentTool,
      permissionMode: userDefaults?.permissionMode || getDefaultPermissionMode(agentTool),
      modelConfig: userDefaults?.modelConfig,
      codexSandboxMode: userDefaults?.codexSandboxMode,
      codexApprovalPolicy: userDefaults?.codexApprovalPolicy,
      codexNetworkAccess: userDefaults?.codexNetworkAccess,
      mcpServerIds: userDefaults?.mcpServerIds || [],
    });
    setSelectedAgent(agentTool);
  }, [open, session, configPreset, form, currentUser]);

  const handleOk = async () => {
    try {
      await form.validateFields();
      // Use getFieldsValue(true) to include values from collapsed panels
      const values = form.getFieldsValue(true);
      const prompt = values.prompt?.trim();

      if (!prompt) {
        return;
      }

      setLoading(true);

      if (action === 'fork') {
        await onConfirm(prompt);
      } else {
        // Build spawn config based on preset
        const spawnConfig: Partial<SpawnConfig> = { prompt };

        if (configPreset === 'custom') {
          // Include full config overrides
          spawnConfig.agent = values.agent || selectedAgent;
          spawnConfig.permissionMode = values.permissionMode;
          spawnConfig.modelConfig = values.modelConfig;
          spawnConfig.codexSandboxMode = values.codexSandboxMode;
          spawnConfig.codexApprovalPolicy = values.codexApprovalPolicy;
          spawnConfig.codexNetworkAccess = values.codexNetworkAccess;
          spawnConfig.mcpServerIds = values.mcpServerIds;
          spawnConfig.extraInstructions = values.extraInstructions;
        }

        // Callback fields are always included when explicitly set
        if (values.enableCallback !== undefined) {
          spawnConfig.enableCallback = values.enableCallback;
        }
        if (values.includeLastMessage !== undefined) {
          spawnConfig.includeLastMessage = values.includeLastMessage;
        }
        if (values.includeOriginalPrompt !== undefined) {
          spawnConfig.includeOriginalPrompt = values.includeOriginalPrompt;
        }

        await onConfirm(spawnConfig);
      }

      form.resetFields();
      onCancel();
    } catch (error) {
      console.error('Form validation failed:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleCancel = () => {
    form.resetFields();
    onCancel();
  };

  const actionLabel = action === 'fork' ? 'Fork' : 'Spawn';
  const actionDescription =
    action === 'fork'
      ? 'Create a sibling session to explore an alternative approach'
      : 'Create a child session to work on a focused subsession';

  return (
    <Modal
      title={
        <div>
          <Typography.Text strong>
            {actionLabel} Session: {session?.title || session?.description || 'Untitled'}
          </Typography.Text>
        </div>
      }
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText={`${actionLabel} Session`}
      confirmLoading={loading}
      width={700}
      forceRender
    >
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {actionDescription}
        </Typography.Text>
      </div>

      <Form form={form} layout="vertical">
        {/* Prompt */}
        <Form.Item
          name="prompt"
          label={`Prompt for ${action === 'fork' ? 'forked' : 'spawned'} session`}
          rules={[{ required: true, message: 'Please enter a prompt' }]}
        >
          <AutocompleteTextarea
            value={form.getFieldValue('prompt') || ''}
            onChange={(value) => form.setFieldValue('prompt', value)}
            placeholder={
              action === 'fork'
                ? 'Try a different approach by... (type @ for autocomplete)'
                : 'Work on this subsession... (type @ for autocomplete)'
            }
            autoSize={{ minRows: 3, maxRows: 8 }}
            client={client}
            sessionId={session?.session_id || null}
            userById={userById}
          />
        </Form.Item>

        {/* Spawn-only options */}
        {action === 'spawn' && (
          <>
            {/* Configuration Preset */}
            <Form.Item label="Configuration">
              <Radio.Group
                value={configPreset}
                onChange={(e) => setConfigPreset(e.target.value)}
                buttonStyle="solid"
              >
                <Radio.Button value="parent">Same as parent</Radio.Button>
                <Radio.Button value="custom">Custom config</Radio.Button>
              </Radio.Group>
            </Form.Item>

            {/* Custom config: agent selection + agentic tool config + extra instructions */}
            {configPreset === 'custom' && (
              <>
                {/* Agent Selection */}
                <Form.Item name="agent" label="Agent">
                  <AgentSelectionGrid
                    agents={AVAILABLE_AGENTS}
                    selectedAgentId={selectedAgent}
                    onSelect={(agentId) => {
                      setSelectedAgent(agentId as AgenticToolName);
                      form.setFieldValue('agent', agentId);
                    }}
                    columns={2}
                  />
                </Form.Item>

                {/* Agentic Tool Configuration (Collapsible) */}
                <Collapse
                  ghost
                  destroyOnHidden={false}
                  expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                  items={[
                    {
                      key: 'agentic-tool-config',
                      label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
                      children: (
                        <AgenticToolConfigForm
                          agenticTool={selectedAgent}
                          mcpServerById={mcpServerById}
                          showHelpText={false}
                        />
                      ),
                    },
                  ]}
                />

                {/* Extra Instructions */}
                <Form.Item
                  name="extraInstructions"
                  label="Extra Instructions (optional)"
                  help="Append additional context or constraints to the spawn prompt"
                  style={{ marginTop: 16 }}
                >
                  <AutocompleteTextarea
                    value={form.getFieldValue('extraInstructions') || ''}
                    onChange={(value) => form.setFieldValue('extraInstructions', value)}
                    placeholder='e.g., "Only use safe operations", "Prioritize performance" (type @ for autocomplete)'
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    client={client}
                    sessionId={session?.session_id || null}
                    userById={userById}
                  />
                </Form.Item>
              </>
            )}

            {/* Callback Options — always visible */}
            <div style={{ marginTop: 16, marginBottom: 16 }}>
              <Typography.Text strong>Callback Options</Typography.Text>
              <Form.Item name="enableCallback" valuePropName="checked" style={{ marginTop: 8 }}>
                <Checkbox>Notify parent on completion</Checkbox>
              </Form.Item>

              <Form.Item
                noStyle
                shouldUpdate={(prev, curr) => prev.enableCallback !== curr.enableCallback}
              >
                {({ getFieldValue }) =>
                  getFieldValue('enableCallback') && (
                    <>
                      <Form.Item
                        name="includeLastMessage"
                        valuePropName="checked"
                        style={{ marginLeft: 24 }}
                      >
                        <Checkbox>Include child&apos;s final result</Checkbox>
                      </Form.Item>

                      <Form.Item
                        name="includeOriginalPrompt"
                        valuePropName="checked"
                        style={{ marginLeft: 24 }}
                      >
                        <Checkbox>Include original prompt</Checkbox>
                      </Form.Item>
                    </>
                  )
                }
              </Form.Item>
            </div>
          </>
        )}
      </Form>
    </Modal>
  );
};
