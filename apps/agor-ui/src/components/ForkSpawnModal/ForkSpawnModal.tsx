/**
 * Modal for forking or spawning sessions from WorktreeCard
 *
 * Prompts user for initial prompt text and calls fork/spawn action
 * For spawn: includes advanced configuration options (agent, callback, etc.)
 */

import type { AgorClient } from '@agor/core/api';
import type {
  AgenticToolName,
  CodexApprovalPolicy,
  CodexSandboxMode,
  MCPServer,
  PermissionMode,
  Session,
  User,
} from '@agor/core/types';
import { getDefaultPermissionMode } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Checkbox, Collapse, Form, Modal, Radio, Typography } from 'antd';
import Handlebars from 'handlebars';
import { useEffect, useMemo, useState } from 'react';
import spawnSubsessionTemplate from '../../templates/spawn_subsession.hbs?raw';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { AgentSelectionGrid } from '../AgentSelectionGrid/AgentSelectionGrid';
import { AVAILABLE_AGENTS } from '../AgentSelectionGrid/availableAgents';
import { AutocompleteTextarea } from '../AutocompleteTextarea';
import { MarkdownRenderer } from '../MarkdownRenderer';
import type { ModelConfig } from '../ModelSelector';

// Register helper to check if value is defined (not undefined)
// This allows us to distinguish between false and undefined in templates
Handlebars.registerHelper('isDefined', (value) => value !== undefined);

// Compile template once at module load (after helper registration)
const compiledSpawnTemplate = Handlebars.compile(spawnSubsessionTemplate);

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
  const [configPreset, setConfigPreset] = useState<'parent' | 'user'>('user');
  const [selectedAgent, setSelectedAgent] = useState<AgenticToolName>(
    session?.agentic_tool || 'claude-code'
  );
  const [formValues, setFormValues] = useState<Partial<SpawnConfig>>({});

  // Reset form when modal opens
  useEffect(() => {
    if (open && session) {
      // Get user's default config for the session's agent
      const agentTool = session.agentic_tool || 'claude-code';
      const userDefaults = currentUser?.default_agentic_config?.[agentTool];

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
              // Inherit parent's callback config - leave undefined if parent has no explicit config
              enableCallback: session.callback_config?.enabled,
              includeLastMessage: session.callback_config?.include_last_message,
              includeOriginalPrompt: session.callback_config?.include_original_prompt,
            }
          : {
              prompt: initialPrompt,
              agent: agentTool,
              permissionMode: userDefaults?.permissionMode || getDefaultPermissionMode(agentTool),
              modelConfig: userDefaults?.modelConfig as ModelConfig | undefined,
              codexSandboxMode: userDefaults?.codexSandboxMode,
              codexApprovalPolicy: userDefaults?.codexApprovalPolicy,
              codexNetworkAccess: userDefaults?.codexNetworkAccess,
              mcpServerIds: userDefaults?.mcpServerIds || [],
              // Leave callback config undefined by default - will use parent's settings
              enableCallback: undefined,
              includeLastMessage: undefined,
              includeOriginalPrompt: undefined,
            };

      form.setFieldsValue(initialValues);
      setSelectedAgent(agentTool);
      setFormValues(initialValues as Partial<SpawnConfig>);
    }
  }, [open, session, configPreset, form, initialPrompt, currentUser]);

  // Render template preview based on current form values
  const renderedTemplate = useMemo(() => {
    if (action === 'fork' || !formValues.prompt) {
      return '';
    }

    try {
      const hasConfig =
        formValues.agent !== undefined ||
        formValues.permissionMode !== undefined ||
        formValues.modelConfig !== undefined ||
        formValues.codexSandboxMode !== undefined ||
        formValues.codexApprovalPolicy !== undefined ||
        formValues.codexNetworkAccess !== undefined ||
        (formValues.mcpServerIds?.length ?? 0) > 0 ||
        formValues.enableCallback !== undefined ||
        formValues.includeLastMessage !== undefined ||
        formValues.includeOriginalPrompt !== undefined ||
        formValues.extraInstructions !== undefined;

      return compiledSpawnTemplate({
        userPrompt: formValues.prompt || '',
        hasConfig,
        agenticTool: formValues.agent || selectedAgent,
        permissionMode: formValues.permissionMode,
        modelConfig: formValues.modelConfig,
        codexSandboxMode: formValues.codexSandboxMode,
        codexApprovalPolicy: formValues.codexApprovalPolicy,
        codexNetworkAccess: formValues.codexNetworkAccess,
        mcpServerIds: formValues.mcpServerIds,
        hasCallbackConfig:
          formValues.enableCallback !== undefined ||
          formValues.includeLastMessage !== undefined ||
          formValues.includeOriginalPrompt !== undefined,
        callbackConfig: {
          enableCallback: formValues.enableCallback,
          includeLastMessage: formValues.includeLastMessage,
          includeOriginalPrompt: formValues.includeOriginalPrompt,
        },
        extraInstructions: formValues.extraInstructions,
      });
    } catch (error) {
      console.error('Template rendering error:', error);
      return '⚠️ Template rendering error';
    }
  }, [action, formValues, selectedAgent]);

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
        // Only include callback fields if explicitly defined (not undefined)
        const spawnConfig: SpawnConfig = {
          prompt,
          agent: values.agent || selectedAgent,
          permissionMode: values.permissionMode,
          modelConfig: values.modelConfig,
          codexSandboxMode: values.codexSandboxMode,
          codexApprovalPolicy: values.codexApprovalPolicy,
          codexNetworkAccess: values.codexNetworkAccess,
          mcpServerIds: values.mcpServerIds,
          ...(values.enableCallback !== undefined && { enableCallback: values.enableCallback }),
          ...(values.includeLastMessage !== undefined && {
            includeLastMessage: values.includeLastMessage,
          }),
          ...(values.includeOriginalPrompt !== undefined && {
            includeOriginalPrompt: values.includeOriginalPrompt,
          }),
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
        onValuesChange={(_, allValues) => setFormValues(allValues)}
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
          />
        </Form.Item>

        {/* Advanced options for spawn only */}
        {action === 'spawn' && (
          <>
            {/* Configuration Preset */}
            <Form.Item label="Configuration Preset">
              <Radio.Group
                value={configPreset}
                onChange={(e) => setConfigPreset(e.target.value)}
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
                onSelect={(agentId) => {
                  setSelectedAgent(agentId as AgenticToolName);
                  form.setFieldValue('agent', agentId);
                  // Manually update formValues to trigger template re-render
                  setFormValues((prev) => ({ ...prev, agent: agentId as AgenticToolName }));
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
                      mcpServerById={mcpServerById}
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

            {/* Template Preview */}
            {renderedTemplate && (
              <Collapse
                ghost
                style={{ marginTop: 24 }}
                expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
                items={[
                  {
                    key: 'template-preview',
                    label: (
                      <Typography.Text strong>
                        🔍 Parent Agent Instruction Preview (Live)
                      </Typography.Text>
                    ),
                    extra: (
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        This is what will be sent to the parent agent
                      </Typography.Text>
                    ),
                    children: (
                      <div>
                        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
                          The parent agent will receive these instructions to prepare a rich,
                          context-aware prompt for the spawned subsession using its current session
                          context.
                        </Typography.Paragraph>
                        <div style={{ maxHeight: 400, overflow: 'auto' }}>
                          <MarkdownRenderer content={`\`\`\`\n${renderedTemplate}\n\`\`\``} />
                        </div>
                      </div>
                    ),
                  },
                ]}
              />
            )}
          </>
        )}
      </Form>
    </Modal>
  );
};
