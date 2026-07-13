import type {
  AgenticToolName,
  AgorClient,
  Branch,
  CodexApprovalPolicy,
  CodexSandboxMode,
  EffortLevel,
  PermissionMode,
  User,
} from '@agor-live/client';
import { getDefaultPermissionMode, mapToCodexPermissionConfig } from '@agor-live/client';
import { DownOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Modal, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectUserById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { getFormValuesFromConfig } from '../AgenticToolConfigForm';
import {
  AgenticToolConfigurationPicker,
  INLINE_AGENTIC_CONFIGURATION,
} from '../AgenticToolConfigurationPicker';
import {
  type AgenticToolOption,
  AgentSelectionGrid,
} from '../AgentSelectionGrid/AgentSelectionGrid';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import type { ModelConfig } from '../ModelSelector';
import { SessionEnvVarsSelector } from '../SessionEnvVarsSelector';
import { SessionAttachmentTray } from '../SessionPanel/SessionAttachmentTray';
import { useComposerAttachments } from '../SessionPanel/useComposerAttachments';

const PASTE_SHORTCUT =
  typeof navigator !== 'undefined' &&
  /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent || '')
    ? '⌘V'
    : 'Ctrl+V';

export interface NewSessionConfig {
  branch_id: string; // Required - sessions are always created from a branch
  agent: string;
  agenticToolPresetId?: string;
  title?: string;
  initialPrompt?: string;

  // Advanced configuration
  modelConfig?: ModelConfig;
  effort?: EffortLevel;
  mcpServerIds?: string[];
  permissionMode?: PermissionMode;
  codexSandboxMode?: CodexSandboxMode;
  codexApprovalPolicy?: CodexApprovalPolicy;
  codexNetworkAccess?: boolean;
  /**
   * Session-scope env var names (belonging to the creator) to export into this
   * session's executor process once it is created.
   */
  envVarNames?: string[];
  /**
   * Raw files pasted/dropped into the initial prompt before the session
   * exists. Uploaded to the new session after creation, then folded into the
   * initial prompt. Never included in the session-create REST payload.
   */
  attachmentFiles?: File[];
}

export interface NewSessionModalProps {
  open: boolean;
  onClose: () => void;
  onCreate: (config: NewSessionConfig) => void;
  availableAgents: AgenticToolOption[];
  branchId: string; // Required - the branch to create the session in
  branch?: Branch; // Optional - branch details for display
  currentUser?: User | null; // Optional - current user for default settings
  client: AgorClient | null;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  open,
  onClose,
  onCreate,
  availableAgents,
  branchId,
  branch,
  currentUser,
  client,
}) => {
  // Entity maps are read from the store rather than drilled through props so
  // the App shell doesn't have to forward them into every modal.
  const mcpServerById = useAgorStore(selectMcpServerById);
  const userById = useAgorStore(selectUserById);
  const [form] = Form.useForm();
  const { showError } = useThemedMessage();
  const [selectedAgent, setSelectedAgent] = useState<string>('claude-code');
  const [isCreating, setIsCreating] = useState(false);
  const [envVarNames, setEnvVarNames] = useState<string[]>([]);
  const { attachments, addAttachments, removeAttachment, clearAttachments } =
    useComposerAttachments({ sessionId: null, showError });
  const isFormValid = !!selectedAgent;

  // Reset form when modal opens, using user defaults if available
  // Only depends on `open` — branch/user refs may change while modal is open
  // and we must not wipe user edits on live WebSocket refreshes.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally only reset on modal open
  useEffect(() => {
    if (!open) return;

    setSelectedAgent('claude-code');
    setIsCreating(false); // Reset creating state when modal opens
    setEnvVarNames([]);
    clearAttachments();

    // Get default config for the selected agent
    const agentDefaults = currentUser?.default_agentic_config?.['claude-code'];
    const baseValues = getFormValuesFromConfig('claude-code', agentDefaults);

    // MCP inheritance: branch config > user defaults
    const branchMcpIds = branch?.mcp_server_ids;

    form.setFieldsValue({
      title: '',
      initialPrompt: '',
      ...baseValues,
      mcpServerIds:
        branchMcpIds && branchMcpIds.length > 0
          ? branchMcpIds
          : currentUser?.default_mcp_server_ids,
    });
  }, [open, form]);

  // Update permission mode and other defaults when agent changes
  useEffect(() => {
    if (selectedAgent) {
      const tool = selectedAgent as AgenticToolName;
      const agentDefaults = currentUser?.default_agentic_config?.[tool];
      const baseValues = getFormValuesFromConfig(tool, agentDefaults);

      // MCP inheritance: branch config > user defaults
      form.setFieldsValue({
        ...baseValues,
        // Clear codex fields when switching away from codex
        ...(tool !== 'codex' && {
          codexSandboxMode: undefined,
          codexApprovalPolicy: undefined,
          codexNetworkAccess: undefined,
        }),
      });
    }
  }, [selectedAgent, form, currentUser]);

  const handleCreate = () => {
    form.validateFields().then(() => {
      // Use getFieldsValue(true) to include values from collapsed panels
      const values = form.getFieldsValue(true);
      // Prevent duplicate submissions
      setIsCreating(true);

      // Get user defaults for the selected agent (fallback if form fields weren't mounted)
      const agentDefaults = currentUser?.default_agentic_config?.[selectedAgent as AgenticToolName];

      // MCP fallback must respect branch > user defaults (same as open-reset effect)
      const branchMcpIds = branch?.mcp_server_ids;
      const fallbackMcpServerIds =
        branchMcpIds && branchMcpIds.length > 0
          ? branchMcpIds
          : currentUser?.default_mcp_server_ids;

      const permissionMode: PermissionMode =
        (values.permissionMode as PermissionMode | undefined) ??
        agentDefaults?.permissionMode ??
        getDefaultPermissionMode(selectedAgent as AgenticToolName);

      const config: NewSessionConfig = {
        branch_id: branchId,
        agent: selectedAgent,
        agenticToolPresetId:
          values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION
            ? undefined
            : values.agenticToolPresetId,
        title: values.title,
        initialPrompt: values.initialPrompt,
        // Daemon's applySessionConfigDefaults hook fills the tool default.
        modelConfig: values.modelConfig ?? agentDefaults?.modelConfig,
        effort: (values.effort as EffortLevel | undefined) ?? agentDefaults?.modelConfig?.effort,
        mcpServerIds: values.mcpServerIds ?? fallbackMcpServerIds,
        permissionMode,
        envVarNames: envVarNames.length > 0 ? envVarNames : undefined,
        attachmentFiles:
          attachments.length > 0 ? attachments.map((attachment) => attachment.file) : undefined,
      };

      if (selectedAgent === 'codex') {
        const codexDefaults = mapToCodexPermissionConfig(permissionMode);
        config.codexSandboxMode =
          (values.codexSandboxMode as CodexSandboxMode | undefined) ??
          agentDefaults?.codexSandboxMode ??
          codexDefaults.sandboxMode;
        config.codexApprovalPolicy =
          (values.codexApprovalPolicy as CodexApprovalPolicy | undefined) ??
          agentDefaults?.codexApprovalPolicy ??
          codexDefaults.approvalPolicy;
        config.codexNetworkAccess =
          values.codexNetworkAccess ??
          agentDefaults?.codexNetworkAccess ??
          codexDefaults.networkAccess;
      }

      onCreate(config);
      // Note: isCreating will be reset when modal reopens via useEffect
    });
  };

  const handleCancel = () => {
    form.resetFields();
    clearAttachments();
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
      maskClosable={false}
      okButtonProps={{
        disabled: !isFormValid || isCreating,
        loading: isCreating,
      }}
    >
      <Form form={form} layout="vertical" style={{ marginTop: 16 }} preserve={false}>
        {/* Branch Info */}
        {branch && (
          <Alert
            title={
              <>
                Creating session in branch: <strong>{branch.name}</strong> ({branch.ref})
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

        <AgenticToolConfigurationPicker
          tool={(selectedAgent as AgenticToolName) || 'claude-code'}
          mcpServerById={mcpServerById}
          showHelpText={true}
          client={client}
        />

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
            placeholder={`e.g., Build a JWT authentication system with secure password storage... (type @ for autocomplete, or ${PASTE_SHORTCUT} to paste a screenshot)`}
            autoSize={{ minRows: 4, maxRows: 8 }}
            client={client}
            sessionId={null}
            userById={userById}
            enableKnowledgeMentions
            kbLinkTarget="absolute-route"
            onFilesDrop={addAttachments}
            filesDropDisabled={isCreating}
          />
        </Form.Item>
        {attachments.length > 0 && (
          <div style={{ padding: '8px 0' }}>
            <SessionAttachmentTray
              attachments={attachments}
              onRemove={removeAttachment}
              disabled={isCreating}
            />
          </div>
        )}

        {/* Advanced Configuration (Collapsible) */}
        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            ...(currentUser && client
              ? [
                  {
                    key: 'env-vars',
                    label: <Typography.Text strong>Environment Variables</Typography.Text>,
                    children: (
                      <SessionEnvVarsSelector
                        ownerUserId={currentUser.user_id}
                        client={client}
                        value={envVarNames}
                        onChange={setEnvVarNames}
                      />
                    ),
                  },
                ]
              : []),
          ]}
          style={{ marginTop: 16 }}
        />
      </Form>
    </Modal>
  );
};
