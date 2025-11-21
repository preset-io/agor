import type { CreateMCPServerInput, MCPServer, UpdateMCPServerInput } from '@agor/core/types';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  Badge,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  message,
  Popconfirm,
  Select,
  Space,
  Switch,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';

const { TextArea } = Input;

// Using Typography.Text directly to avoid DOM Text interface collision

interface MCPServersTableProps {
  mcpServerById: Map<string, MCPServer>;
  onCreate?: (data: CreateMCPServerInput) => void;
  onUpdate?: (serverId: string, updates: UpdateMCPServerInput) => void;
  onDelete?: (serverId: string) => void;
}

interface MCPServerFormFieldsProps {
  mode: 'create' | 'edit';
  transport?: 'stdio' | 'http' | 'sse';
  onTransportChange?: (transport: 'stdio' | 'http' | 'sse') => void;
  authType?: 'none' | 'bearer' | 'jwt';
  onAuthTypeChange?: (authType: 'none' | 'bearer' | 'jwt') => void;
  form: FormInstance;
}

const MCPServerFormFields: React.FC<MCPServerFormFieldsProps> = ({
  mode,
  transport,
  onTransportChange,
  authType = 'none',
  onAuthTypeChange,
  form,
}) => {
  const [testing, setTesting] = useState(false);

  const handleTestConnection = async () => {
    const values = form.getFieldsValue();
    const currentAuthType = values.auth_type || authType;

    setTesting(true);
    try {
      if (currentAuthType === 'jwt') {
        const apiUrl = values.jwt_api_url;
        const apiToken = values.jwt_api_token;
        const apiSecret = values.jwt_api_secret;

        if (!apiUrl || !apiToken || !apiSecret) {
          message.error('Please fill in all JWT authentication fields');
          return;
        }

        // Call daemon to test JWT auth (avoids CORS issues)
        const daemonUrl = import.meta.env.VITE_DAEMON_URL || 'http://localhost:3030';
        const response = await fetch(`${daemonUrl}/mcp-servers/test-jwt`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'include',
          body: JSON.stringify({
            api_url: apiUrl,
            api_token: apiToken,
            api_secret: apiSecret,
          }),
        });

        if (!response.ok) {
          const errorData = await response.json().catch(() => ({}));
          throw new Error(errorData.message || `HTTP ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();
        if (data.success) {
          message.success('JWT authentication successful - token received');
        } else {
          message.error(data.error || 'JWT authentication failed');
        }
      } else if (currentAuthType === 'bearer') {
        const token = values.auth_token;
        if (token) {
          message.success('Bearer token configured');
        } else {
          message.warning('No bearer token provided');
        }
      } else {
        message.info('No auth configured');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      message.error(`Connection test failed: ${errorMessage}`);
    } finally {
      setTesting(false);
    }
  };

  return (
    <>
      {mode === 'create' && (
        <>
          <Form.Item
            label="Name"
            name="name"
            rules={[{ required: true, message: 'Please enter a server name' }]}
            tooltip="Internal identifier (e.g., filesystem, sentry)"
          >
            <Input placeholder="filesystem" />
          </Form.Item>

          <Form.Item
            label="Display Name"
            name="display_name"
            tooltip="User-friendly name shown in UI"
          >
            <Input placeholder="Filesystem Access" />
          </Form.Item>
        </>
      )}

      {mode === 'edit' && (
        <Form.Item label="Display Name" name="display_name">
          <Input placeholder="Filesystem Access" />
        </Form.Item>
      )}

      <Form.Item label="Description" name="description">
        <TextArea placeholder="Optional description..." rows={2} />
      </Form.Item>

      {mode === 'create' && (
        <Form.Item
          label="Transport"
          name="transport"
          rules={[{ required: true }]}
          initialValue="stdio"
        >
          <Select onChange={(value) => onTransportChange?.(value as 'stdio' | 'http' | 'sse')}>
            <Select.Option value="stdio">stdio (Local process)</Select.Option>
            <Select.Option value="http">HTTP</Select.Option>
            <Select.Option value="sse">SSE (Server-Sent Events)</Select.Option>
          </Select>
        </Form.Item>
      )}

      {(mode === 'create' ? transport === 'stdio' : transport === 'stdio') ? (
        <>
          <Form.Item
            label="Command"
            name="command"
            rules={mode === 'create' ? [{ required: true, message: 'Please enter a command' }] : []}
            tooltip="Command to execute (e.g., npx, node, python)"
          >
            <Input placeholder="npx" />
          </Form.Item>

          <Form.Item
            label="Arguments"
            name="args"
            tooltip="Comma-separated arguments. Each argument will be passed separately to the command. Example: -y, @modelcontextprotocol/server-filesystem, /allowed/path"
          >
            <Input placeholder="-y, @modelcontextprotocol/server-filesystem, /allowed/path" />
          </Form.Item>
        </>
      ) : (
        <>
          <Form.Item
            label="URL"
            name="url"
            rules={mode === 'create' ? [{ required: true, message: 'Please enter a URL' }] : []}
          >
            <Input placeholder="https://mcp.example.com" />
          </Form.Item>

          <Form.Item
            label="Auth Type"
            name="auth_type"
            initialValue="none"
            tooltip="Authentication method for the MCP server"
          >
            <Select onChange={(value) => onAuthTypeChange?.(value as 'none' | 'bearer' | 'jwt')}>
              <Select.Option value="none">None</Select.Option>
              <Select.Option value="bearer">Bearer Token</Select.Option>
              <Select.Option value="jwt">JWT</Select.Option>
            </Select>
          </Form.Item>

          {authType === 'bearer' && (
            <Form.Item
              label="Token"
              name="auth_token"
              rules={[{ required: true, message: 'Please enter a bearer token' }]}
              tooltip="Bearer token for authentication"
            >
              <Input.Password placeholder="Enter bearer token" />
            </Form.Item>
          )}

          {authType === 'jwt' && (
            <>
              <Form.Item
                label="API URL"
                name="jwt_api_url"
                rules={[{ required: true, message: 'Please enter the API URL' }]}
                tooltip="URL of the JWT authentication API"
              >
                <Input placeholder="https://auth.example.com/token" />
              </Form.Item>

              <Form.Item
                label="API Token"
                name="jwt_api_token"
                rules={[{ required: true, message: 'Please enter the API token' }]}
                tooltip="Token for the JWT authentication API"
              >
                <Input.Password placeholder="Enter API token" />
              </Form.Item>

              <Form.Item
                label="API Secret"
                name="jwt_api_secret"
                rules={[{ required: true, message: 'Please enter the API secret' }]}
                tooltip="Secret for the JWT authentication API"
              >
                <Input.Password placeholder="Enter API secret" />
              </Form.Item>
            </>
          )}

          <Form.Item>
            <Button type="default" loading={testing} onClick={handleTestConnection}>
              Test Connection
            </Button>
          </Form.Item>
        </>
      )}

      <Form.Item
        label="Scope"
        name="scope"
        initialValue="global"
        tooltip="Where this server is available"
      >
        <Select>
          <Select.Option value="global">Global (all sessions)</Select.Option>
          <Select.Option value="repo">Repository</Select.Option>
          <Select.Option value="session">Session</Select.Option>
        </Select>
      </Form.Item>

      <Form.Item
        label="Environment Variables"
        name="env"
        tooltip="JSON object of environment variables"
      >
        <TextArea placeholder='{"API_KEY": "xxx", "ALLOWED_PATHS": "/path"}' rows={3} />
      </Form.Item>

      <Form.Item label="Enabled" name="enabled" valuePropName="checked" initialValue={true}>
        <Switch />
      </Form.Item>
    </>
  );
};

export const MCPServersTable: React.FC<MCPServersTableProps> = ({
  mcpServerById,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [viewingServer, setViewingServer] = useState<MCPServer | null>(null);
  const [form] = Form.useForm();
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt'>('none');

  const handleCreate = () => {
    form.validateFields().then((values) => {
      const data: CreateMCPServerInput = {
        name: values.name,
        display_name: values.display_name,
        description: values.description,
        transport: values.transport,
        scope: values.scope || 'global',
        enabled: values.enabled ?? true,
        source: 'user',
      };

      // Add transport-specific fields
      if (values.transport === 'stdio') {
        data.command = values.command;
        data.args = values.args?.split(',').map((arg: string) => arg.trim()) || [];
      } else {
        data.url = values.url;
      }

      // Add auth config if present
      if (values.auth_type && values.auth_type !== 'none') {
        data.auth = {
          type: values.auth_type,
        };
        if (values.auth_type === 'bearer') {
          data.auth.token = values.auth_token;
        } else if (values.auth_type === 'jwt') {
          data.auth.api_url = values.jwt_api_url;
          data.auth.api_token = values.jwt_api_token;
          data.auth.api_secret = values.jwt_api_secret;
        }
      }

      // Add env vars if present
      if (values.env) {
        try {
          data.env = JSON.parse(values.env);
        } catch {
          // Invalid JSON, skip
        }
      }

      onCreate?.(data);
      form.resetFields();
      setCreateModalOpen(false);
      setTransport('stdio');
    });
  };

  const handleEdit = (server: MCPServer) => {
    setEditingServer(server);
    const serverAuthType = (server.auth?.type as 'none' | 'bearer' | 'jwt') || 'none';
    setAuthType(serverAuthType);
    form.setFieldsValue({
      display_name: server.display_name,
      description: server.description,
      command: server.command,
      args: server.args?.join(', '),
      url: server.url,
      scope: server.scope,
      enabled: server.enabled,
      env: server.env ? JSON.stringify(server.env, null, 2) : undefined,
      auth_type: serverAuthType,
      auth_token: server.auth?.token,
      jwt_api_url: server.auth?.api_url,
      jwt_api_token: server.auth?.api_token,
      jwt_api_secret: server.auth?.api_secret,
    });
    setEditModalOpen(true);
  };

  const handleUpdate = () => {
    if (!editingServer) return;

    form.validateFields().then((values) => {
      const updates: UpdateMCPServerInput = {
        display_name: values.display_name,
        description: values.description,
        scope: values.scope,
        enabled: values.enabled,
      };

      // Add transport-specific fields
      if (editingServer.transport === 'stdio') {
        updates.command = values.command;
        updates.args = values.args?.split(',').map((arg: string) => arg.trim()) || [];
      } else {
        updates.url = values.url;
      }

      // Add env vars if present
      if (values.env) {
        try {
          updates.env = JSON.parse(values.env);
        } catch {
          // Invalid JSON, skip
        }
      }

      // Add auth config if present
      if (values.auth_type && values.auth_type !== 'none') {
        updates.auth = {
          type: values.auth_type,
        };
        if (values.auth_type === 'bearer') {
          updates.auth.token = values.auth_token;
        } else if (values.auth_type === 'jwt') {
          updates.auth.api_url = values.jwt_api_url;
          updates.auth.api_token = values.jwt_api_token;
          updates.auth.api_secret = values.jwt_api_secret;
        }
      } else {
        updates.auth = undefined;
      }

      onUpdate?.(editingServer.mcp_server_id, updates);
      form.resetFields();
      setEditModalOpen(false);
      setEditingServer(null);
    });
  };

  const handleView = (server: MCPServer) => {
    setViewingServer(server);
    setViewModalOpen(true);
  };

  const handleDelete = (serverId: string) => {
    onDelete?.(serverId);
  };

  const columns = [
    {
      title: 'Name',
      dataIndex: 'name',
      key: 'name',
      width: 180,
      render: (_: string, server: MCPServer) => (
        <div>
          <div>{server.display_name || server.name}</div>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {server.name}
          </Typography.Text>
        </div>
      ),
    },
    {
      title: 'Transport',
      dataIndex: 'transport',
      key: 'transport',
      width: 100,
      render: (transport: string) => (
        <Tag color={transport === 'stdio' ? 'blue' : 'green'}>{transport.toUpperCase()}</Tag>
      ),
    },
    {
      title: 'Scope',
      dataIndex: 'scope',
      key: 'scope',
      width: 100,
      render: (scope: string) => {
        const colors: Record<string, string> = {
          global: 'purple',
          repo: 'cyan',
          session: 'magenta',
        };
        return <Tag color={colors[scope]}>{scope}</Tag>;
      },
    },
    {
      title: 'Status',
      dataIndex: 'enabled',
      key: 'enabled',
      width: 100,
      render: (enabled: boolean) =>
        enabled ? (
          <Badge status="success" text="Enabled" />
        ) : (
          <Badge status="default" text="Disabled" />
        ),
    },
    {
      title: 'Source',
      dataIndex: 'source',
      key: 'source',
      width: 100,
      render: (source: string) => <Typography.Text type="secondary">{source}</Typography.Text>,
    },
    {
      title: 'Actions',
      key: 'actions',
      width: 140,
      render: (_: unknown, server: MCPServer) => (
        <Space size="small">
          <Button
            type="text"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleView(server)}
            title="View details"
          />
          <Button
            type="text"
            size="small"
            icon={<EditOutlined />}
            onClick={() => handleEdit(server)}
            title="Edit"
          />
          <Popconfirm
            title="Delete MCP server?"
            description={`Are you sure you want to delete "${server.display_name || server.name}"?`}
            onConfirm={() => handleDelete(server.mcp_server_id)}
            okText="Delete"
            cancelText="Cancel"
            okButtonProps={{ danger: true }}
          >
            <Button type="text" size="small" icon={<DeleteOutlined />} danger title="Delete" />
          </Popconfirm>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <div
        style={{
          marginBottom: 16,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Typography.Text type="secondary">
          Configure Model Context Protocol servers for enhanced AI capabilities.
        </Typography.Text>
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
          New MCP Server
        </Button>
      </div>

      <Table
        dataSource={mapToArray(mcpServerById)}
        columns={columns}
        rowKey="mcp_server_id"
        pagination={{ pageSize: 10, showSizeChanger: true }}
        size="small"
      />

      {/* Create MCP Server Modal */}
      <Modal
        title="Add MCP Server"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={() => {
          form.resetFields();
          setCreateModalOpen(false);
          setTransport('stdio');
          setAuthType('none');
        }}
        okText="Create"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields
            mode="create"
            transport={transport}
            onTransportChange={setTransport}
            authType={authType}
            onAuthTypeChange={setAuthType}
            form={form}
          />
        </Form>
      </Modal>

      {/* Edit MCP Server Modal */}
      <Modal
        title="Edit MCP Server"
        open={editModalOpen}
        onOk={handleUpdate}
        onCancel={() => {
          form.resetFields();
          setEditModalOpen(false);
          setEditingServer(null);
          setAuthType('none');
        }}
        okText="Save"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields
            mode="edit"
            transport={editingServer?.transport}
            authType={authType}
            onAuthTypeChange={setAuthType}
            form={form}
          />
        </Form>
      </Modal>

      {/* View MCP Server Modal */}
      <Modal
        title="MCP Server Details"
        open={viewModalOpen}
        onCancel={() => {
          setViewModalOpen(false);
          setViewingServer(null);
        }}
        footer={[
          <Button key="close" onClick={() => setViewModalOpen(false)}>
            Close
          </Button>,
        ]}
        width={700}
      >
        {viewingServer && (
          <Descriptions bordered column={1} size="small" style={{ marginTop: 16 }}>
            <Descriptions.Item label="ID">
              {(viewingServer.mcp_server_id as string).substring(0, 8)}
            </Descriptions.Item>
            <Descriptions.Item label="Name">{viewingServer.name}</Descriptions.Item>
            {viewingServer.display_name && (
              <Descriptions.Item label="Display Name">
                {viewingServer.display_name}
              </Descriptions.Item>
            )}
            {viewingServer.description && (
              <Descriptions.Item label="Description">{viewingServer.description}</Descriptions.Item>
            )}
            <Descriptions.Item label="Transport">
              <Tag color={viewingServer.transport === 'stdio' ? 'blue' : 'green'}>
                {viewingServer.transport.toUpperCase()}
              </Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Scope">
              <Tag>{viewingServer.scope}</Tag>
            </Descriptions.Item>
            <Descriptions.Item label="Source">{viewingServer.source}</Descriptions.Item>
            <Descriptions.Item label="Status">
              {viewingServer.enabled ? (
                <Badge status="success" text="Enabled" />
              ) : (
                <Badge status="default" text="Disabled" />
              )}
            </Descriptions.Item>

            {viewingServer.command && (
              <Descriptions.Item label="Command">{viewingServer.command}</Descriptions.Item>
            )}
            {viewingServer.args && viewingServer.args.length > 0 && (
              <Descriptions.Item label="Arguments">
                {viewingServer.args.join(', ')}
              </Descriptions.Item>
            )}
            {viewingServer.url && (
              <Descriptions.Item label="URL">{viewingServer.url}</Descriptions.Item>
            )}

            {viewingServer.env && Object.keys(viewingServer.env).length > 0 && (
              <Descriptions.Item label="Environment Variables">
                <pre style={{ margin: 0, fontSize: 12 }}>
                  {JSON.stringify(viewingServer.env, null, 2)}
                </pre>
              </Descriptions.Item>
            )}

            {viewingServer.tools && viewingServer.tools.length > 0 && (
              <Descriptions.Item label="Tools">
                {viewingServer.tools.length} tools
              </Descriptions.Item>
            )}
            {viewingServer.resources && viewingServer.resources.length > 0 && (
              <Descriptions.Item label="Resources">
                {viewingServer.resources.length} resources
              </Descriptions.Item>
            )}
            {viewingServer.prompts && viewingServer.prompts.length > 0 && (
              <Descriptions.Item label="Prompts">
                {viewingServer.prompts.length} prompts
              </Descriptions.Item>
            )}

            <Descriptions.Item label="Created">
              {new Date(viewingServer.created_at).toLocaleString()}
            </Descriptions.Item>
            {viewingServer.updated_at && (
              <Descriptions.Item label="Updated">
                {new Date(viewingServer.updated_at).toLocaleString()}
              </Descriptions.Item>
            )}
          </Descriptions>
        )}
      </Modal>
    </div>
  );
};
