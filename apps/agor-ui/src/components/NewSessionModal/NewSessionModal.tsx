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
import {
  DEFAULT_CLAUDE_MODEL,
  getDefaultPermissionMode,
  mapToCodexPermissionConfig,
} from '@agor-live/client';
import { DownOutlined, InfoCircleOutlined } from '@ant-design/icons';
import { Alert, Collapse, Form, Input, Modal, Space, Tooltip, Typography } from 'antd';
import { useEffect, useState } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { selectMcpServerById, selectUserById } from '../../store/selectors';
import { useThemedMessage } from '../../utils/message';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import type { AgenticFormValues } from '../AgenticToolConfigForm';
import { getFormValuesFromConfig } from '../AgenticToolConfigForm';
import {
  INLINE_AGENTIC_CONFIGURATION,
  persistUserDefaultFromForm,
} from '../AgenticToolConfigurationPicker';
import {
  type AgenticToolOption,
  AgentSelectionGrid,
} from '../AgentSelectionGrid/AgentSelectionGrid';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { CodexSettingsForm } from '../CodexSettingsForm';
import { AdvisorModelSelect, type ModelConfig } from '../ModelSelector';
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

  const watchedModelConfig = Form.useWatch('modelConfig', form) as ModelConfig | undefined;
  const watchedPresetId = Form.useWatch('agenticToolPresetId', form) as string | undefined;
  const isClaudeAgent = selectedAgent === 'claude-code' || selectedAgent === 'claude-code-cli';
  // The daemon overwrites model_config with the resolved preset/default when a
  // non-inline configuration is chosen, so the Advanced advisor override only
  // takes effect (and is only offered) while inline configuration is active.
  const isInlineConfig = watchedPresetId === INLINE_AGENTIC_CONFIGURATION;

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
      // Never carry a checked save-as-default across opens — it could silently
      // overwrite the user's default on a later create.
      saveAsDefault: false,
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

      const isInline = values.agenticToolPresetId === INLINE_AGENTIC_CONFIGURATION;

      // Promote the inline config to the user's default when requested. Fire and
      // forget — session creation shouldn't block on the profile patch.
      if (values.saveAsDefault && isInline && currentUser && client) {
        const formValues: AgenticFormValues = {
          modelConfig: values.modelConfig,
          effort: values.effort as EffortLevel | undefined,
          permissionMode: values.permissionMode,
          codexSandboxMode: values.codexSandboxMode,
          codexApprovalPolicy: values.codexApprovalPolicy,
          codexNetworkAccess: values.codexNetworkAccess,
        };
        void persistUserDefaultFromForm(
          client,
          currentUser,
          selectedAgent as AgenticToolName,
          formValues
        ).catch(() => showError('Failed to save your default configuration'));
      }

      const config: NewSessionConfig = {
        branch_id: branchId,
        agent: selectedAgent,
        agenticToolPresetId: isInline ? undefined : values.agenticToolPresetId,
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

  const setAdvisorModel = (advisorModel: string | undefined) => {
    const current = form.getFieldValue('modelConfig') as ModelConfig | undefined;
    form.setFieldValue('modelConfig', {
      mode: current?.mode ?? 'alias',
      model: current?.model || DEFAULT_CLAUDE_MODEL,
      ...(current?.provider ? { provider: current.provider } : {}),
      advisorModel,
    });
  };

  // Only report the advisor as "on" when it will actually apply (inline config).
  const advisorOn = isInlineConfig && !!watchedModelConfig?.advisorModel;
  const advancedBits: string[] = [];
  if (envVarNames.length > 0) {
    advancedBits.push(`${envVarNames.length} env var${envVarNames.length === 1 ? '' : 's'}`);
  }
  if (isClaudeAgent && isInlineConfig && advisorOn) advancedBits.push('advisor on');
  if (selectedAgent === 'codex') advancedBits.push('Codex sandbox');
  const advancedSummary = `Advanced${advancedBits.length > 0 ? ` · ${advancedBits.join(' · ')}` : ''}`;

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

        {/* Session Title — name the thing first */}
        <Form.Item name="title" label="Title (optional)">
          <Input placeholder="e.g., Add authentication system" />
        </Form.Item>

        {/* Initial Prompt */}
        <Form.Item name="initialPrompt" label="Initial Prompt (optional)">
          <AutocompleteTextarea
            value={form.getFieldValue('initialPrompt') || ''}
            onChange={(value) => form.setFieldValue('initialPrompt', value)}
            placeholder={`First message to send when the session starts — e.g., Build a JWT auth system… (type @ for autocomplete, or ${PASTE_SHORTCUT} to paste a screenshot)`}
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

        {/* Agent Selection — dense tiles */}
        <Form.Item label="Coding Agent" required>
          <AgentSelectionGrid
            agents={availableAgents}
            selectedAgentId={selectedAgent}
            onSelect={setSelectedAgent}
            columns={3}
            size="small"
            showComparisonLink={false}
          />
        </Form.Item>

        {/* Configuration — resolved config as editable chips under the tiles */}
        <Form.Item label="Configuration">
          <AgenticConfigChipRow
            tool={(selectedAgent as AgenticToolName) || 'claude-code'}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            client={client}
            enableSaveAsDefault
          />
        </Form.Item>

        {/* Advanced Configuration (Collapsible) */}
        <Collapse
          ghost
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'advanced',
              label: <Typography.Text type="secondary">{advancedSummary}</Typography.Text>,
              children: (
                <>
                  {currentUser && client && (
                    <Form.Item label="Environment Variables">
                      <SessionEnvVarsSelector
                        ownerUserId={currentUser.user_id}
                        client={client}
                        value={envVarNames}
                        onChange={setEnvVarNames}
                      />
                    </Form.Item>
                  )}

                  {isClaudeAgent && isInlineConfig && (
                    <Form.Item
                      label={
                        <Space size={4}>
                          <span>Advisor model</span>
                          <Tooltip title="Optional Claude Code advisor-tool model. Leave off to use your existing Claude settings.">
                            <InfoCircleOutlined />
                          </Tooltip>
                        </Space>
                      }
                    >
                      <AdvisorModelSelect
                        value={watchedModelConfig?.advisorModel}
                        onChange={setAdvisorModel}
                        client={client}
                      />
                    </Form.Item>
                  )}

                  {selectedAgent === 'codex' && <CodexSettingsForm showHelpText={false} />}
                </>
              ),
            },
          ]}
          style={{ marginTop: 16 }}
        />
      </Form>
    </Modal>
  );
};
