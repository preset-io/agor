import type { MCPServer, Session } from '@agor/core/types';
import { DownOutlined } from '@ant-design/icons';
import { Collapse, Form, Modal, Typography } from 'antd';
import React from 'react';
import { AdvancedSettingsForm } from '../AdvancedSettingsForm';
import { AgenticToolConfigForm } from '../AgenticToolConfigForm';
import type { ModelConfig } from '../ModelSelector';
import { SessionMetadataForm } from '../SessionMetadataForm';

export interface SessionSettingsModalProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  mcpServers: MCPServer[];
  sessionMcpServerIds: string[];
  onUpdate?: (sessionId: string, updates: Partial<Session>) => void;
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
  onUpdateModelConfig?: (sessionId: string, modelConfig: ModelConfig) => void;
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
  onUpdateModelConfig,
}) => {
  const [form] = Form.useForm();

  // Store initial values when modal opens to prevent re-renders from overwriting user input
  const [initialValues, setInitialValues] = React.useState<{
    title: string;
    mcpServerIds: string[];
    modelConfig: ModelConfig | undefined;
    permissionMode: string;
    custom_context: string;
  }>({
    title: '',
    mcpServerIds: [],
    modelConfig: undefined,
    permissionMode: 'acceptEdits',
    custom_context: '',
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
        custom_context: session.custom_context
          ? JSON.stringify(session.custom_context, null, 2)
          : '',
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
    session.custom_context,
    sessionMcpServerIds,
    form,
  ]);

  const handleOk = () => {
    form.validateFields().then(values => {
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

      // Apply session updates if any
      if (Object.keys(updates).length > 0 && onUpdate) {
        onUpdate(session.session_id, updates);
      }

      // Backward compatibility: also call onUpdateModelConfig if provided
      if (values.modelConfig && onUpdateModelConfig) {
        onUpdateModelConfig(session.session_id, values.modelConfig);
      }

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
