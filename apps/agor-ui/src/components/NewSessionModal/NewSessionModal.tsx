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
import { Button, Collapse, Flex, Form, Input, Modal, Tooltip, Typography, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';
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
  getUserAgenticToolDefault,
  getUserDefaultConfigurationSource,
} from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import {
  type AgenticToolOption,
  AgentSelectionGrid,
} from '../AgentSelectionGrid/AgentSelectionGrid';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { CodexSettingsForm } from '../CodexSettingsForm';
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
  const { token } = theme.useToken();
  const { showError } = useThemedMessage();
  const [selectedAgent, setSelectedAgent] = useState<string>('claude-code');
  const [isCreating, setIsCreating] = useState(false);
  const [envVarNames, setEnvVarNames] = useState<string[]>([]);
  const [configValidity, setConfigValidity] = useState<{ valid: boolean; reason?: string }>({
    valid: true,
  });
  const { attachments, addAttachments, removeAttachment, clearAttachments } =
    useComposerAttachments({ sessionId: null, showError });

  // Stable callback so the chip row's reporting effect doesn't loop.
  const handleConfigValidity = useCallback((valid: boolean, reason?: string) => {
    setConfigValidity((prev) =>
      prev.valid === valid && prev.reason === reason ? prev : { valid, reason }
    );
  }, []);

  // The only genuinely-required input is an agent (always preselected); the
  // configuration is the one thing that can become unresolvable (admin edge).
  // Everything else defaults, so the happy path needs zero input.
  const missingReason = !selectedAgent
    ? 'Select an agent to continue'
    : !configValidity.valid
      ? configValidity.reason
      : undefined;
  const canCreate = !missingReason;

  const watchedPresetId = Form.useWatch('agenticToolPresetId', form) as string | undefined;
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
    const agentDefaults = getUserAgenticToolDefault(currentUser, 'claude-code').configuration;
    const baseValues = getFormValuesFromConfig('claude-code', agentDefaults);

    // MCP inheritance: branch config > user defaults
    const branchMcpIds = branch?.mcp_server_ids;

    form.resetFields();
    form.setFieldsValue({
      title: '',
      initialPrompt: '',
      agenticToolPresetId: getUserDefaultConfigurationSource(currentUser, 'claude-code'),
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
      const agentDefaults = getUserAgenticToolDefault(currentUser, tool).configuration;
      const baseValues = getFormValuesFromConfig(tool, agentDefaults);

      // MCP inheritance: branch config > user defaults
      form.setFieldsValue({
        ...baseValues,
        agenticToolPresetId: getUserDefaultConfigurationSource(currentUser, tool),
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
      const agentDefaults = getUserAgenticToolDefault(
        currentUser,
        selectedAgent as AgenticToolName
      ).configuration;

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

  const advancedBits: string[] = [];
  if (envVarNames.length > 0) {
    advancedBits.push(`${envVarNames.length} env var${envVarNames.length === 1 ? '' : 's'}`);
  }
  if (selectedAgent === 'codex' && isInlineConfig) advancedBits.push('Codex sandbox');
  const advancedSummary = `Advanced${advancedBits.length > 0 ? ` · ${advancedBits.join(' · ')}` : ''}`;

  return (
    <Modal
      title={branch ? `New Session · ${branch.name}` : 'Create New Session'}
      open={open}
      onCancel={handleCancel}
      width={700}
      maskClosable={false}
      footer={
        <Flex justify="flex-end" gap={token.marginXS}>
          <Button onClick={handleCancel}>Cancel</Button>
          {/* Disabled buttons don't emit hover events, so the wrapper span carries
              the Tooltip that explains what's blocking creation. */}
          <Tooltip title={missingReason}>
            <span style={{ display: 'inline-block' }}>
              <Button
                type="primary"
                onClick={handleCreate}
                disabled={!canCreate || isCreating}
                loading={isCreating}
                style={canCreate ? undefined : { pointerEvents: 'none' }}
              >
                Create Session
              </Button>
            </span>
          </Tooltip>
        </Flex>
      }
    >
      <Form
        form={form}
        layout="vertical"
        preserve={false}
        style={{ marginTop: 16 }}
        // Render the required mark as a suffix ("Label *", before any info icon)
        // rather than antd's default "* Label" prefix.
        requiredMark={(label, { required }) => (
          <>
            {label}
            {required && (
              <span style={{ color: token.colorError, marginInlineStart: token.marginXXS }}>*</span>
            )}
          </>
        )}
      >
        {/* Agent Selection — dense tiles (pick who you're talking to first) */}
        <Form.Item label="Coding Agent" required>
          <AgentSelectionGrid
            agents={availableAgents}
            selectedAgentId={selectedAgent}
            onSelect={setSelectedAgent}
            columns={4}
            size="small"
            showComparisonLink={false}
          />
        </Form.Item>

        {/* Configuration — source Select + resolved chips */}
        <AgenticConfigChipRow
          tool={(selectedAgent as AgenticToolName) || 'claude-code'}
          mcpServerById={mcpServerById}
          currentUser={currentUser}
          client={client}
          enableSaveAsDefault
          onConfigValidityChange={handleConfigValidity}
        />

        {/* Session Title */}
        <Form.Item
          name="title"
          label="Title"
          tooltip="Auto-generated from your first prompt when left blank."
        >
          <Input placeholder="e.g., Add authentication system" />
        </Form.Item>

        {/* Initial Prompt */}
        <Form.Item
          name="initialPrompt"
          label="Initial Prompt"
          tooltip={`Optional — the first message sent when the session starts. Type @ to reference files or knowledge, or paste (${PASTE_SHORTCUT}) a screenshot. Sessions can also start idle and be prompted later.`}
        >
          <AutocompleteTextarea
            value={form.getFieldValue('initialPrompt') || ''}
            onChange={(value) => form.setFieldValue('initialPrompt', value)}
            placeholder="e.g., Build a JWT authentication system"
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
          <div style={{ paddingBlock: token.paddingXS }}>
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
            {
              key: 'advanced',
              label: <Typography.Text type="secondary">{advancedSummary}</Typography.Text>,
              children: (
                <>
                  {currentUser && client && (
                    <Form.Item
                      label="Environment Variables"
                      tooltip="Exported into this session's executor process."
                    >
                      <SessionEnvVarsSelector
                        ownerUserId={currentUser.user_id}
                        client={client}
                        value={envVarNames}
                        onChange={setEnvVarNames}
                      />
                    </Form.Item>
                  )}

                  {selectedAgent === 'codex' && isInlineConfig && (
                    <CodexSettingsForm showHelpText={false} />
                  )}
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
