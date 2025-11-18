import type { CreateMCPServerInput, MCPServer, UpdateMCPServerInput } from '@agor/core/types';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
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
}

const MCPServerFormFields: React.FC<MCPServerFormFieldsProps> = ({
  mode,
  transport,
  onTransportChange,
}) => {
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

          <Form.Item label="Arguments" name="args" tooltip="Comma-separated arguments">
            <Input placeholder="@modelcontextprotocol/server-filesystem, /allowed/path" />
          </Form.Item>
        </>
      ) : (
        <Form.Item
          label="URL"
          name="url"
          rules={mode === 'create' ? [{ required: true, message: 'Please enter a URL' }] : []}
        >
          <Input placeholder="https://mcp.example.com" />
        </Form.Item>
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
    form.setFieldsValue({
      display_name: server.display_name,
      description: server.description,
      command: server.command,
      args: server.args?.join(', '),
      url: server.url,
      scope: server.scope,
      enabled: server.enabled,
      env: server.env ? JSON.stringify(server.env, null, 2) : undefined,
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
        }}
        okText="Create"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields
            mode="create"
            transport={transport}
            onTransportChange={setTransport}
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
        }}
        okText="Save"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields mode="edit" transport={editingServer?.transport} />
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
