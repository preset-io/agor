/**
 * Modal for forking or spawning sessions from WorktreeCard
 *
 * Prompts user for initial prompt text and calls fork/spawn action
 * For spawn: includes advanced configuration options (agent, callback, etc.)
 */

import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  MCPServer,
  PermissionMode,
  Session,
} from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Checkbox, Collapse, Form, Input, Modal, Radio, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../AgentSelectionGrid/AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import type { ModelConfig } from '../ModelSelector';

const { TextArea } = Input;

export type ForkSpawnAction = 'fork' | 'spawn';

export interface SpawnConfig {
  prompt: string;
  agent?: AgenticToolName;
  permissionMode?: PermissionMode;
  modelConfig?: ModelConfig;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  mcpServerIds?: string[];
  enableCallback?: boolean;
  includeLastMessage?: boolean;
  includeOriginalPrompt?: boolean;
  extraInstructions?: string;
}

export interface ForkSpawnModalProps {
  open: boolean;
  action: ForkSpawnAction;
  session: Session | null;
  mcpServers?: MCPServer[];
  initialPrompt?: string;
  onConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  onCancel: () => void;
}

export const ForkSpawnModal: React.FC<ForkSpawnModalProps> = ({
  open,
  action,
  session,
  mcpServers = [],
  initialPrompt = '',
  onConfirm,
  onCancel,
}) => {
  const [form] = Form.useForm();
  const [loading, setLoading] = useState(false);
  const [configPreset, setConfigPreset] = useState<'parent' | 'user'>('user');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>(
    session?.agentic_tool || 'claude-code'
  );

  // Reset form when modal opens
  useEffect(() => {
    if (open && session) {
      // Set initial values based on preset
      const initialValues =
        configPreset === 'parent'
          ? {
              prompt: initialPrompt,
              agent: session.agentic_tool,
              permissionMode:
                session.permission_config?.mode || getDefaultPermissionMode(session.agentic_tool),
              modelConfig: session.model_config,
              codexSandboxMode: session.permission_config?.codex?.sandboxMode,
              codexApprovalPolicy: session.permission_config?.codex?.approvalPolicy,
              codexNetworkAccess: session.permission_config?.codex?.networkAccess,
              mcpServerIds: [],
              enableCallback: true,
              includeLastMessage: true,
              includeOriginalPrompt: false, // Default off since parent knows the prompt
            }
          : {
              prompt: initialPrompt,
              agent: session.agentic_tool,
              permissionMode: getDefaultPermissionMode(session.agentic_tool),
              enableCallback: true,
              includeLastMessage: true,
              includeOriginalPrompt: false, // Default off since parent knows the prompt
            };

      form.setFieldsValue(initialValues);
      setSelectedAgent(session.agentic_tool || 'claude-code');
    }
  }, [open, session, configPreset, form, initialPrompt]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      const prompt = values.prompt?.trim();

      if (!prompt) {
        return;
      }

      setLoading(true);

      if (action === 'fork') {
        // Fork - simple prompt string
        await onConfirm(prompt);
      } else {
        // Spawn - full configuration object
        const spawnConfig: SpawnConfig = {
          prompt,
          agent: values.agent || selectedAgent,
          permissionMode: values.permissionMode,
          modelConfig: values.modelConfig,
          codexSandboxMode: values.codexSandboxMode,
          codexApprovalPolicy: values.codexApprovalPolicy,
          codexNetworkAccess: values.codexNetworkAccess,
          mcpServerIds: values.mcpServerIds,
          enableCallback: values.enableCallback,
          includeLastMessage: values.includeLastMessage,
          includeOriginalPrompt: values.includeOriginalPrompt,
          extraInstructions: values.extraInstructions,
        };
        await onConfirm(spawnConfig);
      }

      form.resetFields();
      onCancel();
    } catch (error) {
      // Validation failed
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
    >
      <div style={{ marginBottom: 16 }}>
        <Typography.Text type="secondary" style={{ fontSize: 13 }}>
          {actionDescription}
        </Typography.Text>
      </div>

      <Form
        form={form}
        layout="vertical"
        initialValues={{ enableCallback: true, includeLastMessage: true }}
      >
        {/* Prompt */}
        <Form.Item
          name="prompt"
          label={`Prompt for ${action === 'fork' ? 'forked' : 'spawned'} session`}
          rules={[{ required: true, message: 'Please enter a prompt' }]}
        >
          <TextArea
            placeholder={
              action === 'fork' ? 'Try a different approach by...' : 'Work on this subsession...'
            }
            autoSize={{ minRows: 3, maxRows: 8 }}
            autoFocus
          />
        </Form.Item>

        {/* Advanced options for spawn only */}
        {action === 'spawn' && (
          <>
            {/* Configuration Preset */}
            <Form.Item label="Configuration Preset">
              <Radio.Group
                value={configPreset}
                onChange={e => setConfigPreset(e.target.value)}
                buttonStyle="solid"
              >
                <Radio.Button value="parent">Same as Parent</Radio.Button>
                <Radio.Button value="user">User Defaults</Radio.Button>
              </Radio.Group>
            </Form.Item>

            {/* Agent Selection */}
            <Form.Item name="agent" label="Agent">
              <AgentSelectionGrid
                agents={AVAILABLE_AGENTS}
                selectedAgentId={selectedAgent}
                onSelect={agentId => {
                  setSelectedAgent(agentId as AgenticToolName);
                  form.setFieldValue('agent', agentId);
                }}
                columns={2}
              />
            </Form.Item>

            {/* Agentic Tool Configuration (Collapsible) */}
            <Collapse
              ghost
              expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
              items={[
                {
                  key: 'agentic-tool-config',
                  label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
                  children: (
                    <AgenticToolConfigForm
                      agenticTool={selectedAgent}
                      mcpServers={mcpServers}
                      showHelpText={false}
                    />
                  ),
                },
              ]}
            />

            {/* Callback Options */}
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

            {/* Extra Instructions */}
            <Form.Item
              name="extraInstructions"
              label="Extra Instructions (optional)"
              help="Append additional context or constraints to the spawn prompt"
            >
              <TextArea
                placeholder='e.g., "Only use safe operations", "Prioritize performance"'
                autoSize={{ minRows: 2, maxRows: 4 }}
              />
            </Form.Item>
          </>
        )}
      </Form>
    </Modal>
  );
};
