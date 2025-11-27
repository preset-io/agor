import type {
  CreateMCPServerInput,
  MCPServer,
  ToolPermission,
  UpdateMCPServerInput,
} from '@agor/core/types';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  Badge,
  Button,
  Descriptions,
  Divider,
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

interface ToolPermissionsEditorProps {
  tools?: Array<{ name: string; description: string }>;
  value?: Record<string, ToolPermission>;
  onChange?: (permissions: Record<string, ToolPermission>) => void;
}

const ToolPermissionsEditor: React.FC<ToolPermissionsEditorProps> = ({
  tools = [],
  value = {},
  onChange,
}) => {
  const handlePermissionChange = (toolName: string, permission: ToolPermission) => {
    const updated = { ...value, [toolName]: permission };
    onChange?.(updated);
  };

  if (!tools || tools.length === 0) {
    return (
      <div
        style={{
          padding: '16px',
          background: 'rgba(0, 0, 0, 0.02)',
          borderRadius: '4px',
          border: '1px solid #d9d9d9',
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          No tools discovered yet. Tools will be discovered automatically when you save the server.
        </Typography.Text>
      </div>
    );
  }

  return (
    <div
      style={{
        maxHeight: '400px',
        overflowY: 'auto',
        border: '1px solid #d9d9d9',
        borderRadius: '4px',
      }}
    >
      {tools.map((tool) => (
        <div
          key={tool.name}
          style={{
            padding: '12px',
            borderBottom: '1px solid #f0f0f0',
            display: 'flex',
            gap: '12px',
            alignItems: 'center',
            background: '#fafafa',
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <Typography.Text strong style={{ fontFamily: 'monospace', fontSize: 13 }}>
              {tool.name}
            </Typography.Text>
            {tool.description && (
              <div style={{ marginTop: 4 }}>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {tool.description}
                </Typography.Text>
              </div>
            )}
          </div>
          <Select
            size="middle"
            value={value[tool.name] || 'ask'}
            onChange={(perm) => handlePermissionChange(tool.name, perm)}
            style={{ minWidth: 100 }}
          >
            <Select.Option value="allow">
              <Typography.Text style={{ color: '#52c41a' }}>Allow</Typography.Text>
            </Select.Option>
            <Select.Option value="ask">
              <Typography.Text style={{ color: '#faad14' }}>Ask</Typography.Text>
            </Select.Option>
            <Select.Option value="deny">
              <Typography.Text style={{ color: '#ff4d4f' }}>Deny</Typography.Text>
            </Select.Option>
          </Select>
        </div>
      ))}
    </div>
  );
};

interface MCPServersTableProps {
  mcpServerById: Map<string, MCPServer>;
  client: import('@agor/core/api').AgorClient | null;
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
  client: import('@agor/core/api').AgorClient | null;
  serverTools?: Array<{ name: string; description: string }>;
  serverId?: string;
  onToolsDiscovered?: () => void;
}

const MCPServerFormFields: React.FC<MCPServerFormFieldsProps> = ({
  mode,
  transport,
  onTransportChange,
  authType = 'none',
  onAuthTypeChange,
  form,
  client,
  serverTools,
  serverId,
  onToolsDiscovered,
}) => {
  const [testing, setTesting] = useState(false);
  const [_discovering, setDiscovering] = useState(false);

  const handleTestConnection = async () => {
    if (!client) {
      message.error('Client not available');
      return;
    }

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

        // Use Feathers client for authenticated request
        const data = (await client.service('mcp-servers/test-jwt').create({
          api_url: apiUrl,
          api_token: apiToken,
          api_secret: apiSecret,
        })) as { success: boolean; error?: string };

        if (data.success) {
          message.success('JWT authentication successful - token received');

          // If in edit mode with serverId, also discover tools
          if (serverId && mode === 'edit') {
            try {
              const discoverData = (await client.service('mcp-servers/discover').create({
                mcp_server_id: serverId,
              })) as {
                success: boolean;
                error?: string;
                capabilities?: { tools: number; resources: number; prompts: number };
              };

              if (discoverData.success && discoverData.capabilities) {
                message.success(
                  `Discovered ${discoverData.capabilities.tools} tools, ${discoverData.capabilities.resources} resources`
                );
                onToolsDiscovered?.();
              }
            } catch (discoverError) {
              console.log('Tool discovery failed (non-fatal):', discoverError);
            }
          }
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

  const _handleDiscoverTools = async () => {
    if (!client) {
      message.error('Client not available');
      return;
    }

    if (!serverId) {
      message.error('Server ID not available - save the server first');
      return;
    }

    setDiscovering(true);
    try {
      const data = (await client.service('mcp-servers/discover').create({
        mcp_server_id: serverId,
      })) as {
        success: boolean;
        error?: string;
        capabilities?: { tools: number; resources: number; prompts: number };
      };

      if (data.success && data.capabilities) {
        message.success(
          `Discovered ${data.capabilities.tools} tools, ${data.capabilities.resources} resources, ${data.capabilities.prompts} prompts`
        );
        onToolsDiscovered?.();
      } else {
        message.error(data.error || 'Tool discovery failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      message.error(`Discovery failed: ${errorMessage}`);
    } finally {
      setDiscovering(false);
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

      <Form.Item
        label="Transport"
        name="transport"
        rules={mode === 'create' ? [{ required: true }] : []}
        initialValue={mode === 'create' ? 'stdio' : undefined}
        tooltip="Connection method: stdio for local processes, HTTP/SSE for remote servers"
      >
        <Select onChange={(value) => onTransportChange?.(value as 'stdio' | 'http' | 'sse')}>
          <Select.Option value="stdio">stdio (Local process)</Select.Option>
          <Select.Option value="http">HTTP</Select.Option>
          <Select.Option value="sse">SSE (Server-Sent Events)</Select.Option>
        </Select>
      </Form.Item>

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

      {mode === 'edit' && (
        <>
          <Divider />
          <Form.Item
            label="Tool Permissions"
            name="tool_permissions"
            tooltip="Configure which tools require permission approval. 'Ask' prompts for each use, 'Allow' auto-approves, 'Deny' blocks the tool."
          >
            <ToolPermissionsEditor tools={serverTools || []} />
          </Form.Item>
        </>
      )}

      <Form.Item label="Enabled" name="enabled" valuePropName="checked" initialValue={true}>
        <Switch />
      </Form.Item>
    </>
  );
};

export const MCPServersTable: React.FC<MCPServersTableProps> = ({
  mcpServerById,
  client,
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
  const [_discovering, setDiscovering] = useState(false);

  const handleCreate = () => {
    form
      .validateFields()
      .then((values) => {
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
      })
      .catch((error) => {
        // Validation failed - form will show errors automatically
        console.log('Form validation failed:', error);
      });
  };

  const handleEdit = async (server: MCPServer) => {
    setEditingServer(server);
    const serverAuthType = (server.auth?.type as 'none' | 'bearer' | 'jwt') || 'none';
    setAuthType(serverAuthType);

    // Set transport state for conditional rendering
    if (server.transport) {
      setTransport(server.transport);
    }

    form.setFieldsValue({
      display_name: server.display_name,
      description: server.description,
      transport: server.transport || (server.url ? 'http' : 'stdio'),
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
      tool_permissions: server.tool_permissions || {},
    });
    setEditModalOpen(true);

    // Auto-discover tools for HTTP/SSE servers
    const transport = server.transport || (server.url ? 'http' : 'stdio');
    if ((transport === 'http' || transport === 'sse') && server.url && client) {
      // Always try to discover/refresh tools for HTTP/SSE servers
      setDiscovering(true);
      try {
        const data = (await client.service('mcp-servers/discover').create({
          mcp_server_id: server.mcp_server_id,
        })) as {
          success: boolean;
          error?: string;
          capabilities?: { tools: number; resources: number; prompts: number };
        };

        if (data.success && data.capabilities) {
          // Refresh server to get newly discovered tools
          const updatedServer = await client.service('mcp-servers').get(server.mcp_server_id);
          setEditingServer(updatedServer as MCPServer);
          console.log(
            '[MCP] Discovered',
            data.capabilities.tools,
            'tools for',
            server.display_name
          );
        } else {
          console.error('[MCP] Discovery failed:', data.error);
        }
      } catch (error) {
        console.error('[MCP] Auto-discovery error:', error);
      } finally {
        setDiscovering(false);
      }
    }
  };

  const handleUpdate = () => {
    if (!editingServer) return;

    form
      .validateFields()
      .then((values) => {
        const updates: UpdateMCPServerInput = {
          display_name: values.display_name,
          description: values.description,
          scope: values.scope,
          enabled: values.enabled,
          transport: values.transport,
        };

        // Add transport-specific fields based on the NEW transport value
        if (values.transport === 'stdio') {
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

        // Add tool permissions if present
        if (values.tool_permissions) {
          updates.tool_permissions = values.tool_permissions;
        }

        // Save the updates first
        onUpdate?.(editingServer.mcp_server_id, updates);

        // Then discover tools for HTTP/SSE servers
        const transport = values.transport || editingServer.transport;
        if ((transport === 'http' || transport === 'sse') && values.url && client) {
          setDiscovering(true);
          client
            .service('mcp-servers/discover')
            .create({
              mcp_server_id: editingServer.mcp_server_id,
            })
            .then((data: { success: boolean; capabilities?: { tools: number } }) => {
              if (data.success && data.capabilities) {
                message.success(`Discovered ${data.capabilities.tools} tools`);
              }
            })
            .catch((error: Error) => {
              console.error('Discovery failed:', error);
              message.error('Failed to discover tools');
            })
            .finally(() => {
              setDiscovering(false);
            });
        }

        form.resetFields();
        setEditModalOpen(false);
        setEditingServer(null);
      })
      .catch((error) => {
        // Validation failed - form will show errors automatically
        console.log('Form validation failed:', error);
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
      width: 80,
      render: (enabled: boolean) =>
        enabled ? (
          <Badge status="success" text="Enabled" />
        ) : (
          <Badge status="default" text="Disabled" />
        ),
    },
    {
      title: 'Health',
      key: 'health',
      width: 100,
      render: (_: unknown, server: MCPServer) => {
        const toolCount = server.tools?.length || 0;
        if (toolCount > 0) {
          return (
            <div>
              <Badge status="success" />
              <Typography.Text style={{ fontSize: 12, marginLeft: 4 }}>
                {toolCount} tools
              </Typography.Text>
            </div>
          );
        }
        return <Badge status="warning" text="Not connected" />;
      },
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
            client={client}
          />
        </Form>
      </Modal>

      {/* Edit MCP Server Modal */}
      <Modal
        title={
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span>Edit MCP Server</span>
            {editingServer &&
              (editingServer.tools && editingServer.tools.length > 0 ? (
                <>
                  <Badge status="success" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {editingServer.tools.length} tools discovered
                  </Typography.Text>
                </>
              ) : (
                <>
                  <Badge status="warning" />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    No tools discovered
                  </Typography.Text>
                </>
              ))}
          </div>
        }
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
            client={client}
            serverTools={editingServer?.tools}
            serverId={editingServer?.mcp_server_id}
            onToolsDiscovered={async () => {
              // Refresh the server data to show newly discovered tools
              if (editingServer && client) {
                try {
                  const updatedServer = await client
                    .service('mcp-servers')
                    .get(editingServer.mcp_server_id);
                  setEditingServer(updatedServer as MCPServer);
                } catch (error) {
                  console.error('Failed to refresh server data:', error);
                }
              }
            }}
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
