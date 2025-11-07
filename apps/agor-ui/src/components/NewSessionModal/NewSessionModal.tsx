import type { AgenticToolName, MCPServer, User, Worktree } from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import {
  type AgenticToolOption,
  AgentSelectionGrid,
} from '../AgentSelectionGrid/AgentSelectionGrid';
import type { ModelConfig } from '../ModelSelector';

const { TextArea } = Input;

export interface NewSessionConfig {
  worktree_id: string; // Required - sessions are always created from a worktree
  agent: string;
  title?: string;
  initialPrompt?: string;

  // Advanced configuration
  modelConfig?: ModelConfig;
  mcpServerIds?: string[];
  permissionMode?: string;
}

export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (config: NewSessionConfig) => void;
  availableAgents: AgenticToolOption[];
  worktreeId: string; // Required - the worktree to create the session in
  worktree?: Worktree; // Optional - worktree details for display
  mcpServers?: MCPServer[];
  currentUser?: User | null; // Optional - current user for default settings
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  open,
  onClose,
  onCreate,
  availableAgents,
  worktreeId,
  worktree,
  mcpServers = [],
  currentUser,
}) => {
  const [form] = Form.useForm();
  const [selectedAgent, setSelectedAgent] = useState<string>('claude-code');
  const [isFormValid, setIsFormValid] = useState(false);

  // Reset form when modal opens, using user defaults if available
  useEffect(() => {
    if (!open) return;

    setSelectedAgent('claude-code');

    // Get default config for the selected agent
    const agentDefaults = currentUser?.default_agentic_config?.['claude-code'];

    form.setFieldsValue({
      title: '',
      initialPrompt: '',
      permissionMode: agentDefaults?.permissionMode || getDefaultPermissionMode('claude-code'),
      mcpServerIds: agentDefaults?.mcpServerIds || [],
      modelConfig: agentDefaults?.modelConfig,
    });
    setIsFormValid(false);
  }, [open, form, currentUser]);

  // Update permission mode and other defaults when agent changes
  useEffect(() => {
    if (selectedAgent) {
      const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent as AgenticToolName];

      form.setFieldsValue({
        permissionMode:
          agentDefaults?.permissionMode ||
          getDefaultPermissionMode((selectedAgent as AgenticToolName) || 'claude-code'),
        mcpServerIds: agentDefaults?.mcpServerIds || [],
        modelConfig: agentDefaults?.modelConfig,
      });
    }
  }, [selectedAgent, form, currentUser]);

  const handleFormChange = () => {
    const hasAgent = !!selectedAgent;
    setIsFormValid(hasAgent);
  };

  const handleCreate = () => {
    form.validateFields().then(values => {
      // Get user defaults for the selected agent (fallback if form fields weren't mounted)
      const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent as AgenticToolName];

      const config: NewSessionConfig = {
        worktree_id: worktreeId,
        agent: selectedAgent,
        title: values.title,
        initialPrompt: values.initialPrompt,
        // Use form values if present (user expanded advanced), otherwise use defaults
        modelConfig: values.modelConfig ?? agentDefaults?.modelConfig,
        mcpServerIds: values.mcpServerIds ?? agentDefaults?.mcpServerIds,
        permissionMode: values.permissionMode ?? (agentDefaults?.permissionMode || getDefaultPermissionMode(selectedAgent as AgenticToolName)),
      };
      onCreate(config);
    });
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title="Create New Session"
      open={open}
      onOk={handleCreate}
      onCancel={handleCancel}
      okText="Create Session"
      cancelText="Cancel"
      width={700}
      okButtonProps={{
        disabled: !isFormValid,
      }}
    >
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        onFieldsChange={handleFormChange}
        preserve={false}
      >
        {/* Worktree Info */}
        {worktree && (
          <Alert
            message={
              <>
                Creating session in worktree: <strong>{worktree.name}</strong> ({worktree.ref})
              </>
            }
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />
        )}

        {/* Agent Selection */}
        <Form.Item label="Select Coding Agent" required>
          <AgentSelectionGrid
            agents={availableAgents}
            selectedAgentId={selectedAgent}
            onSelect={setSelectedAgent}
            columns={3}
            showHelperText={true}
            showComparisonLink={true}
          />
        </Form.Item>

        {/* Session Title */}
        <Form.Item name="title" label="Title (optional)">
          <Input placeholder="e.g., Add authentication system" />
        </Form.Item>

        {/* Initial Prompt */}
        <Form.Item
          name="initialPrompt"
          label="Initial Prompt (optional)"
          help="First message to send to the agent when session starts"
        >
          <TextArea
            rows={4}
            placeholder="e.g., Build a JWT authentication system with secure password storage..."
          />
        </Form.Item>

        {/* Advanced Configuration (Collapsible) */}
        <Collapse
          ghost
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'agentic-tool-config',
              label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
              children: (
                <AgenticToolConfigForm
                  agenticTool={(selectedAgent as AgenticToolName) || 'claude-code'}
                  mcpServers={mcpServers}
                  showHelpText={true}
                />
              ),
            },
          ]}
          style={{ marginTop: 16 }}
        />
      </Form>
    </Modal>
  );
};
