import type { CodexApprovalPolicy, CodexSandboxMode, MCPServer, Session } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Collapse, Form, Modal, Typography } from 'antd';
import React from 'react';
import { AdvancedSettingsForm } from '../AdvancedSettingsForm';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import { CallbackConfigForm } from '../CallbackConfigForm';
import { SessionMetadataForm } from '../SessionMetadataForm';

export interface SessionSettingsModalProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  mcpServers: MCPServer[];
  sessionMcpServerIds: string[];
  onUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
}

/**
 * Session Settings Modal
 *
 * Unified settings modal for sessions (used from both SessionCard and SessionDrawer)
 * Allows editing:
 * - Session title
 * - Claude model configuration
 * - MCP Server attachments
 */
export const SessionSettingsModal: React.FC<SessionSettingsModalProps> = ({
  open,
  onClose,
  session,
  mcpServers,
  sessionMcpServerIds,
  onUpdate,
  onUpdateSessionMcpServers,
}) => {
  const [form] = Form.useForm();

  // Store initial values when modal opens to prevent re-renders from overwriting user input
  const [initialValues, setInitialValues] = React.useState<{
    title: string;
    mcpServerIds: string[];
    modelConfig: Session['model_config'];
    permissionMode: string;
    codexSandboxMode: CodexSandboxMode;
    codexApprovalPolicy: CodexApprovalPolicy;
    codexNetworkAccess: boolean;
    custom_context: string;
    callbackConfig: {
      enabled: boolean;
      includeLastMessage: boolean;
      template?: string;
    };
  }>({
    title: '',
    mcpServerIds: [],
    modelConfig: undefined,
    permissionMode: 'acceptEdits',
    codexSandboxMode: 'workspace-write',
    codexApprovalPolicy: 'on-request',
    codexNetworkAccess: false,
    custom_context: '',
    callbackConfig: {
      enabled: true,
      includeLastMessage: true,
      template: undefined,
    },
  });

  // Reset form values only when modal opens (not on every prop change)
  React.useEffect(() => {
    if (open) {
      // Get default permission mode based on agentic tool type
      const defaultPermissionMode = session.agentic_tool === 'codex' ? 'auto' : 'acceptEdits';

      const values = {
        title: session.title || '',
        mcpServerIds: sessionMcpServerIds,
        modelConfig: session.model_config,
        permissionMode: session.permission_config?.mode || defaultPermissionMode,
        codexSandboxMode: session.permission_config?.codex?.sandboxMode || 'workspace-write',
        codexApprovalPolicy: session.permission_config?.codex?.approvalPolicy || 'on-request',
        codexNetworkAccess: session.permission_config?.codex?.networkAccess ?? false,
        custom_context: session.custom_context
          ? JSON.stringify(session.custom_context, null, 2)
          : '',
        callbackConfig: {
          enabled: session.callback_config?.enabled ?? true,
          includeLastMessage: session.callback_config?.include_last_message ?? true,
          template: session.callback_config?.template,
        },
      };

      setInitialValues(values);
      form.setFieldsValue(values);
    }
  }, [
    open,
    session.title,
    session.agentic_tool,
    session.model_config,
    session.permission_config?.mode,
    session.permission_config?.codex?.sandboxMode,
    session.permission_config?.codex?.approvalPolicy,
    session.permission_config?.codex?.networkAccess,
    session.custom_context,
    session.callback_config?.enabled,
    session.callback_config?.include_last_message,
    session.callback_config?.template,
    sessionMcpServerIds,
    form,
  ]);

  const handleOk = () => {
    form.validateFields().then((values) => {
      // Collect all updates
      const updates: Partial<Session> = {};

      // Update session title
      if (values.title !== session.title) {
        updates.title = values.title;
      }

      // Update model config
      if (values.modelConfig) {
        updates.model_config = {
          ...values.modelConfig,
          updated_at: new Date().toISOString(),
        };
      }

      // Update permission config
      if (values.permissionMode) {
        updates.permission_config = {
          ...session.permission_config,
          mode: values.permissionMode,
        };
      }

      // Update Codex network access (only for Codex sessions)
      if (session.agentic_tool === 'codex') {
        const sandboxMode: CodexSandboxMode =
          values.codexSandboxMode ||
          session.permission_config?.codex?.sandboxMode ||
          'workspace-write';
        const approvalPolicy: CodexApprovalPolicy =
          values.codexApprovalPolicy ||
          session.permission_config?.codex?.approvalPolicy ||
          'on-request';
        const networkAccess =
          values.codexNetworkAccess ?? session.permission_config?.codex?.networkAccess ?? false;

        updates.permission_config = {
          ...session.permission_config,
          ...updates.permission_config,
          codex: {
            sandboxMode,
            approvalPolicy,
            networkAccess,
          },
        };
      }

      // Update custom context (parse JSON)
      if (values.custom_context) {
        try {
          const parsedContext = JSON.parse(values.custom_context);
          updates.custom_context = parsedContext;
        } catch (error) {
          console.error('Failed to parse custom context JSON:', error);
          // Don't update if JSON is invalid
        }
      } else if (values.custom_context === '') {
        // Empty string = remove custom context
        updates.custom_context = undefined;
      }

      // Update callback config
      if (values.callbackConfig) {
        updates.callback_config = {
          enabled: values.callbackConfig.enabled ?? true,
          include_last_message: values.callbackConfig.includeLastMessage ?? true,
          template: values.callbackConfig.template || undefined,
        };
      }

      // Apply session updates if any
      if (Object.keys(updates).length > 0 && onUpdate) {
        onUpdate(session.session_id, updates);
      }

      // Note: model_config is already included in updates above, so no need for separate onUpdateModelConfig call
      // (it would cause duplicate session updates)

      // Update MCP server attachments
      if (onUpdateSessionMcpServers) {
        onUpdateSessionMcpServers(session.session_id, values.mcpServerIds || []);
      }

      onClose();
    });
  };

  const handleCancel = () => {
    form.resetFields();
    onClose();
  };

  return (
    <Modal
      title="Session Settings"
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Save"
      cancelText="Cancel"
      width={600}
    >
      <Form form={form} layout="vertical" initialValues={initialValues}>
        <Collapse
          ghost
          defaultActiveKey={['metadata', 'agentic-tool-config']}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'metadata',
              label: <Typography.Text strong>Session Metadata</Typography.Text>,
              children: (
                <SessionMetadataForm showHelpText={true} titleRequired={false} titleLabel="Title" />
              ),
            },
            {
              key: 'agentic-tool-config',
              label: <Typography.Text strong>Agentic Tool Configuration</Typography.Text>,
              children: (
                <AgenticToolConfigForm
                  agenticTool={session.agentic_tool}
                  mcpServers={mcpServers}
                  showHelpText={true}
                />
              ),
            },
            {
              key: 'callback-config',
              label: <Typography.Text strong>Callback Configuration</Typography.Text>,
              children: <CallbackConfigForm showHelpText={true} />,
            },
            {
              key: 'advanced',
              label: <Typography.Text strong>Advanced</Typography.Text>,
              children: <AdvancedSettingsForm showHelpText={true} />,
            },
          ]}
        />
      </Form>
    </Modal>
  );
};
