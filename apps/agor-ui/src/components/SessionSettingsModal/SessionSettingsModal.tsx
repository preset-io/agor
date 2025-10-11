import type { MCPServer } from '@agor/core/types';
import { Form, Modal, Typography } from 'antd';
import type { Session } from '../../types';
import { MCPServerSelect } from '../MCPServerSelect';

const { Text } = Typography;

export interface SessionSettingsModalProps {
  open: boolean;
  onClose: () => void;
  session: Session;
  mcpServers: MCPServer[];
  sessionMcpServerIds: string[];
  onUpdateSessionMcpServers?: (sessionId: string, mcpServerIds: string[]) => void;
}

/**
 * Session Settings Modal
 *
 * Displays session-specific configuration options:
 * - MCP Server attachments
 * - Future: Concepts, environment variables, etc.
 */
export const SessionSettingsModal: React.FC<SessionSettingsModalProps> = ({
  open,
  onClose,
  session,
  mcpServers,
  sessionMcpServerIds,
  onUpdateSessionMcpServers,
}) => {
  const [form] = Form.useForm();

  const handleOk = () => {
    form.validateFields().then(values => {
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
      title={`Session Settings - ${session.agent}`}
      open={open}
      onOk={handleOk}
      onCancel={handleCancel}
      okText="Save"
      cancelText="Cancel"
      width={600}
    >
      <Form
        form={form}
        layout="vertical"
        initialValues={{
          mcpServerIds: sessionMcpServerIds,
        }}
      >
        <Form.Item
          name="mcpServerIds"
          label="MCP Servers"
          help="Select which MCP servers this session can access"
        >
          <MCPServerSelect mcpServers={mcpServers} placeholder="No MCP servers attached" />
        </Form.Item>

        <Text type="secondary" style={{ fontSize: 12 }}>
          MCP (Model Context Protocol) servers provide tools, resources, and context to the AI
          agent. Changes will apply to new prompts sent to this session.
        </Text>
      </Form>
    </Modal>
  );
};
