import type { AgorClient } from '@agor/core/api';
import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  MCPServer,
  PermissionMode,
  User,
  Worktree,
} from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import {
  type AgenticToolOption,
  AgentSelectionGrid,
} from '../AgentSelectionGrid/AgentSelectionGrid';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import type { ModelConfig } from '../ModelSelector';

export interface NewSessionConfig {
  worktree_id: string; // Required - sessions are always created from a worktree
  agent: string;
  title?: string;
  initialPrompt?: string;

  // Advanced configuration
  modelConfig?: ModelConfig;
  mcpServerIds?: string[];
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
}

export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (config: NewSessionConfig) => void;
  availableAgents: AgenticToolOption[];
  worktreeId: string; // Required - the worktree to create the session in
  worktree?: Worktree; // Optional - worktree details for display
  mcpServerById?: Map<string, MCPServer>;
  currentUser?: User | null; // Optional - current user for default settings
  client: AgorClient | null;
  userById: Map<string, User>;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  open,
  onClose,
  onCreate,
  availableAgents,
  worktreeId,
  worktree,
  mcpServerById = new Map(),
  currentUser,
  client,
  userById,
}) => {
  const [form] = Form.useForm();
  const [selectedAgent, setSelectedAgent] = useState<string>('claude-code');
  const [isCreating, setIsCreating] = useState(false);
  const isFormValid = !!selectedAgent;

  // Reset form when modal opens, using user defaults if available
  useEffect(() => {
    if (!open) return;

    setSelectedAgent('claude-code');
    setIsCreating(false); // Reset creating state when modal opens

    // Get default config for the selected agent
    const agentDefaults = currentUser?.default_agentic_config?.['claude-code'];

    form.setFieldsValue({
      title: '',
      initialPrompt: '',
      permissionMode: agentDefaults?.permissionMode || getDefaultPermissionMode('claude-code'),
      mcpServerIds: agentDefaults?.mcpServerIds || [],
      modelConfig: agentDefaults?.modelConfig,
      codexSandboxMode: agentDefaults?.codexSandboxMode || 'workspace-write',
      codexApprovalPolicy: agentDefaults?.codexApprovalPolicy || 'on-request',
      codexNetworkAccess: agentDefaults?.codexNetworkAccess ?? false,
    });
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
        ...(selectedAgent === 'codex'
          ? {
              codexSandboxMode: agentDefaults?.codexSandboxMode || 'workspace-write',
              codexApprovalPolicy: agentDefaults?.codexApprovalPolicy || 'on-request',
              codexNetworkAccess: agentDefaults?.codexNetworkAccess ?? false,
            }
          : {
              codexSandboxMode: undefined,
              codexApprovalPolicy: undefined,
              codexNetworkAccess: undefined,
            }),
      });
    }
  }, [selectedAgent, form, currentUser]);

  const handleCreate = () => {
    form.validateFields().then((values) => {
      // Prevent duplicate submissions
      setIsCreating(true);

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
        permissionMode:
          (values.permissionMode as PermissionMode | undefined) ??
          agentDefaults?.permissionMode ??
          getDefaultPermissionMode(selectedAgent as AgenticToolName),
      };

      if (selectedAgent === 'codex') {
        config.codexSandboxMode =
          (values.codexSandboxMode as CodexSandboxMode | undefined) ??
          agentDefaults?.codexSandboxMode ??
          ('workspace-write' as CodexSandboxMode);
        config.codexApprovalPolicy =
          (values.codexApprovalPolicy as CodexApprovalPolicy | undefined) ??
          agentDefaults?.codexApprovalPolicy ??
          ('on-request' as CodexApprovalPolicy);
        config.codexNetworkAccess =
          values.codexNetworkAccess ?? agentDefaults?.codexNetworkAccess ?? false;
      }

      onCreate(config);
      // Note: isCreating will be reset when modal reopens via useEffect
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
        disabled: !isFormValid || isCreating,
        loading: isCreating,
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }} preserve={false}>
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
            columns={2}
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
          <AutocompleteTextarea
            value={form.getFieldValue('initialPrompt') || ''}
            onChange={(value) => form.setFieldValue('initialPrompt', value)}
            placeholder="e.g., Build a JWT authentication system with secure password storage... (type @ for autocomplete)"
            autoSize={{ minRows: 4, maxRows: 8 }}
            client={client}
            sessionId={null}
            userById={userById}
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
                  mcpServerById={mcpServerById}
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
