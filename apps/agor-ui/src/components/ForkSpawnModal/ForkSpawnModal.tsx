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
import { Checkbox, Form, Modal, Radio, Typography, theme } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { AgenticConfigChipRow } from '../AgenticConfigChipRow';
import { INLINE_AGENTIC_CONFIGURATION } from '../AgenticToolConfigurationPicker';
import {
  getUserAgenticToolDefault,
  USER_DEFAULT_AGENTIC_CONFIGURATION,
} from '../AgenticToolConfigurationPicker/useAgenticConfigurationSources';
import { AgentSelectionGrid } from '../AgentSelectionGrid/AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { CodexSettingsForm } from '../CodexSettingsForm';
import { SessionEnvVarsSelector } from '../SessionEnvVarsSelector';

export type ForkSpawnAction = 'fork' | 'spawn';

export interface ForkSpawnModalProps {
  open: boolean;
  action: ForkSpawnAction;
  session: Session | null;
  currentUser?: User | null;
  mcpServerById?: Map<string, MCPServer>;
  initialPrompt?: string;
  onConfirm: (config: string | Partial<SpawnConfig>) => Promise<void>;
  afterClose?: () => void;
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
  afterClose,
  onCancel,
  client,
  userById,
}) => {
  const [form] = Form.useForm();
  const { token } = theme.useToken();
  const [loading, setLoading] = useState(false);
  const [configPreset, setConfigPreset] = useState<'parent' | 'custom'>('parent');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>(
    session?.agentic_tool || 'claude-code'
  );

  const watchedPresetId = Form.useWatch('agenticToolPresetId', form) as string | undefined;
  const isInlineConfig = watchedPresetId === INLINE_AGENTIC_CONFIGURATION;

  const [envVarNames, setEnvVarNames] = useState<string[]>([]);

  const getCustomConfigDefaults = useCallback(
    (agentTool: AgenticToolName) => {
      const { selection: userSelection, configuration: userDefaults } = getUserAgenticToolDefault(
        currentUser,
        agentTool
      );
      const sameToolAsParent = agentTool === session?.agentic_tool;
      const modelConfig =
        userDefaults?.modelConfig ?? (sameToolAsParent ? session?.model_config : undefined);
      return {
        agent: agentTool,
        // Seed the config source from the parent (same tool): the parent's preset
        // if it used one, else inline — so the chip row's Select reflects the
        // parent's actual config, mirroring SessionSettingsModal.
        agenticToolPresetId: sameToolAsParent
          ? (session?.agentic_tool_preset_id ?? INLINE_AGENTIC_CONFIGURATION)
          : userSelection || userDefaults
            ? USER_DEFAULT_AGENTIC_CONFIGURATION
            : undefined,
        permissionMode:
          userDefaults?.permissionMode ||
          (sameToolAsParent ? session?.permission_config?.mode : undefined) ||
          getDefaultPermissionMode(agentTool),
        // Existing user defaults are sent as explicit form values. If the user
        // has no saved model default and the child keeps the same tool, leaving
        // this undefined would inherit the parent model in resolveChildSessionConfig;
        // initialize that effective value so the chips don't imply a different default.
        modelConfig,
        // Surfaced as its own field (the effort chip binds to it), folded back
        // into model_config on submit.
        effort: modelConfig?.effort,
        codexSandboxMode: userDefaults?.codexSandboxMode,
        codexApprovalPolicy: userDefaults?.codexApprovalPolicy,
        codexNetworkAccess: userDefaults?.codexNetworkAccess,
      };
    },
    [currentUser, session]
  );

  // Reset form and preset when modal opens
  useEffect(() => {
    if (open && session) {
      setConfigPreset('parent');
      setEnvVarNames([]);
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

  // When switching to "Custom config", load the values that will be
  // effective if the user submits without touching individual fields.
  useEffect(() => {
    if (!open || !session || configPreset !== 'custom') return;
    const agentTool = session.agentic_tool || 'claude-code';
    form.setFieldsValue({
      ...getCustomConfigDefaults(agentTool),
      mcpServerIds: currentUser?.default_mcp_server_ids || [],
    });
    setSelectedAgent(agentTool);
  }, [
    open,
    session,
    configPreset,
    form,
    getCustomConfigDefaults,
    currentUser?.default_mcp_server_ids,
  ]);

  const handleOk = async () => {
    // Validate fields first. If validation fails, bail out WITHOUT clearing
    // the form — the user's prompt text must be preserved.
    try {
      await form.validateFields();
    } catch (error) {
      console.error('Form validation failed:', error);
      return;
    }

    // Use getFieldsValue(true) to include values from collapsed panels
    const values = form.getFieldsValue(true);
    const prompt = values.prompt?.trim();

    if (!prompt) {
      return;
    }

    setLoading(true);

    try {
      if (action === 'fork') {
        await onConfirm(prompt);
      } else {
        // Build spawn config based on preset
        const spawnConfig: Partial<SpawnConfig> = { prompt };

        if (configPreset === 'custom') {
          spawnConfig.agent = values.agent || selectedAgent;
          if (
            values.agenticToolPresetId &&
            values.agenticToolPresetId !== INLINE_AGENTIC_CONFIGURATION
          ) {
            spawnConfig.presetId = values.agenticToolPresetId;
          } else {
            spawnConfig.permissionMode = values.permissionMode;
            // Fold the standalone effort field back into model_config.
            spawnConfig.modelConfig = values.modelConfig
              ? { ...values.modelConfig, ...(values.effort ? { effort: values.effort } : {}) }
              : values.effort
                ? { effort: values.effort }
                : undefined;
            spawnConfig.codexSandboxMode = values.codexSandboxMode;
            spawnConfig.codexApprovalPolicy = values.codexApprovalPolicy;
            spawnConfig.codexNetworkAccess = values.codexNetworkAccess;
          }
          // MCP attachments are session-scoped and remain editable regardless
          // of whether the agent configuration comes from a preset or inline.
          spawnConfig.mcpServerIds = values.mcpServerIds;
          spawnConfig.extraInstructions = values.extraInstructions;
          // Always send envVarNames in custom preset so the user can
          // explicitly clear inherited selections (empty array = explicit
          // clear; `undefined` = "copy parent", which is only the
          // `parent` preset's intent).
          spawnConfig.envVarNames = envVarNames;
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

      // Only reset + close on success. If onConfirm rejects, the modal stays
      // open so the user's typed prompt is not lost.
      form.resetFields();
      onCancel();
    } catch (error) {
      console.error(
        `Failed to ${action} session — keeping modal open so prompt is preserved:`,
        error
      );
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
      afterClose={afterClose}
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

      <Form
        form={form}
        layout="vertical"
        // Suffix-style required mark ("Label *"), matching NewSessionModal.
        requiredMark={(label, { required }) => (
          <>
            {label}
            {required && (
              <span style={{ color: token.colorError, marginInlineStart: token.marginXXS }}>*</span>
            )}
          </>
        )}
      >
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
            enableKnowledgeMentions
            kbLinkTarget="absolute-route"
          />
        </Form.Item>

        {/* Spawn-only options */}
        {action === 'spawn' && (
          <>
            {/* Start-from preset vs a custom configuration */}
            <Form.Item label="Start from">
              <Radio.Group
                value={configPreset}
                onChange={(e) => setConfigPreset(e.target.value)}
                buttonStyle="solid"
              >
                <Radio.Button value="parent">Same as parent</Radio.Button>
                <Radio.Button value="custom">Custom config</Radio.Button>
              </Radio.Group>
            </Form.Item>

            {/* Custom config: agent selection + config chip row + extra instructions */}
            {configPreset === 'custom' && (
              <>
                {/* Agent Selection */}
                <Form.Item name="agent" label="Agent">
                  <AgentSelectionGrid
                    agents={AVAILABLE_AGENTS}
                    selectedAgentId={selectedAgent}
                    onSelect={(agentId) => {
                      const agentTool = agentId as AgenticToolName;
                      setSelectedAgent(agentTool);
                      form.setFieldsValue(getCustomConfigDefaults(agentTool));
                    }}
                    columns={2}
                  />
                </Form.Item>

                {/* Configuration source Select + resolved chips — parity with NewSessionModal */}
                <AgenticConfigChipRow
                  tool={selectedAgent}
                  mcpServerById={mcpServerById}
                  currentUser={currentUser}
                  client={client}
                />

                {selectedAgent === 'codex' && isInlineConfig && (
                  <CodexSettingsForm showHelpText={false} />
                )}

                {/* Session-scope env var selections (only the creator / admin
                    can actually persist these; backend silently ignores for others). */}
                {currentUser && client && (
                  <Form.Item
                    label="Environment Variables"
                    tooltip="Exported into the spawned session's executor process."
                  >
                    <SessionEnvVarsSelector
                      ownerUserId={currentUser.user_id}
                      client={client}
                      value={envVarNames}
                      onChange={setEnvVarNames}
                      hideEmptyMessage
                    />
                  </Form.Item>
                )}

                {/* Extra Instructions */}
                <Form.Item
                  name="extraInstructions"
                  label="Extra Instructions"
                  tooltip="Appended as additional context or constraints to the spawn prompt."
                >
                  <AutocompleteTextarea
                    value={form.getFieldValue('extraInstructions') || ''}
                    onChange={(value) => form.setFieldValue('extraInstructions', value)}
                    placeholder='e.g., "Only use safe operations", "Prioritize performance" (type @ for autocomplete)'
                    autoSize={{ minRows: 2, maxRows: 4 }}
                    client={client}
                    sessionId={session?.session_id || null}
                    userById={userById}
                    enableKnowledgeMentions
                    kbLinkTarget="absolute-route"
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
