import type { CreateMCPServerInput, MCPServer } from '@agor-live/client';
import { DeleteOutlined, EditOutlined, EyeOutlined, PlusOutlined } from '@ant-design/icons';
import {
  Badge,
  Button,
  Descriptions,
  Form,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { MCPServerEditModal, MCPServerFormFields } from '../MCPServer';
import { buildAuthFromValues, parseEnvJSON } from '../MCPServer/mcp-oauth-utils';

interface MCPServersTableProps {
  mcpServerById: Map<string, MCPServer>;
  client: import('@agor-live/client').AgorClient | null;
  onCreate?: (data: CreateMCPServerInput) => void;
  onDelete?: (serverId: string) => void;
}

interface TestResult {
  success: boolean;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  error?: string;
  tools?: Array<{ name: string; description: string }>;
  resources?: Array<{ name: string; uri: string; mimeType?: string }>;
  prompts?: Array<{ name: string; description: string }>;
}

export const MCPServersTable: React.FC<MCPServersTableProps> = ({
  mcpServerById,
  client,
  onCreate,
  onDelete,
}) => {
  const { showError } = useThemedMessage();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [viewingServer, setViewingServer] = useState<MCPServer | null>(null);
  const [createForm] = Form.useForm();
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt' | 'oauth'>('none');
  const [testing, setTesting] = useState(false);
  const [alreadyCreatedInOAuthFlow, setAlreadyCreatedInOAuthFlow] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Sync editing server when mcpServerById updates (real-time WebSocket updates).
  // Also keeps the open edit modal in sync if the underlying record changes.
  useEffect(() => {
    if (editingServer && mcpServerById.has(editingServer.mcp_server_id)) {
      const updatedServer = mcpServerById.get(editingServer.mcp_server_id);
      if (updatedServer && updatedServer !== editingServer) {
        setEditingServer(updatedServer);
      }
    }
  }, [mcpServerById, editingServer]);

  const buildCreateData = (values: Record<string, unknown>): CreateMCPServerInput => {
    const data: CreateMCPServerInput = {
      name: values.name as string,
      display_name: values.display_name as string | undefined,
      description: values.description as string | undefined,
      transport: values.transport as 'stdio' | 'http' | 'sse',
      scope: (values.scope as 'global' | 'session' | undefined) || 'global',
      enabled: (values.enabled as boolean | undefined) ?? true,
      source: 'user',
    };

    if (values.transport === 'stdio') {
      data.command = values.command as string;
      data.args = (values.args as string)?.split(',').map((arg: string) => arg.trim()) || [];
    } else {
      data.url = values.url as string;
    }

    const auth = buildAuthFromValues(values);
    if (auth) data.auth = auth;

    const env = parseEnvJSON(values.env);
    if (env) data.env = env;

    return data;
  };

  // Save server first for OAuth flow in create mode (returns new server ID)
  const handleSaveFirstForCreate = async (): Promise<string | null> => {
    if (!client) return null;
    try {
      await createForm.validateFields();
      const data = buildCreateData(createForm.getFieldsValue(true));
      const result = await client.service('mcp-servers').create(data);
      setAlreadyCreatedInOAuthFlow(true);
      return (result as MCPServer).mcp_server_id || null;
    } catch {
      return null;
    }
  };

  const resetCreateModal = () => {
    createForm.resetFields();
    setCreateModalOpen(false);
    setTransport('stdio');
    setAuthType('none');
    setTestResult(null);
    setAlreadyCreatedInOAuthFlow(false);
  };

  const handleCreate = () => {
    if (alreadyCreatedInOAuthFlow) {
      resetCreateModal();
      return;
    }

    createForm
      .validateFields()
      .then(() => {
        const data = buildCreateData(createForm.getFieldsValue(true));
        onCreate?.(data);
        resetCreateModal();
      })
      .catch((error) => {
        console.error('Form validation failed:', error);
        if (error.errorFields && error.errorFields.length > 0) {
          const firstError = error.errorFields[0];
          showError(firstError.errors[0] || 'Please fill in required fields');
        }
      });
  };

  // Test connection from create modal (always inline config, no persistence).
  const handleCreateTestConnection = async () => {
    if (!client) {
      showError('Client not available');
      return;
    }

    const values = createForm.getFieldsValue(true);

    if (!values.url) {
      showError('URL is required to test connection');
      return;
    }
    if (values.transport === 'stdio') {
      showError('Connection test is not available for stdio transport');
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const data = (await client.service('mcp-servers/discover').create({
        url: values.url,
        transport: values.transport || 'http',
        auth: buildAuthFromValues(values),
      })) as {
        success: boolean;
        error?: string;
        capabilities?: { tools: number; resources: number; prompts: number };
        tools?: Array<{ name: string; description: string }>;
        resources?: Array<{ name: string; uri: string; mimeType?: string }>;
        prompts?: Array<{ name: string; description: string }>;
      };

      if (data.success && data.capabilities) {
        setTestResult({
          success: true,
          toolCount: data.capabilities.tools,
          resourceCount: data.capabilities.resources,
          promptCount: data.capabilities.prompts,
          tools: data.tools,
          resources: data.resources,
          prompts: data.prompts,
        });
      } else {
        setTestResult({
          success: false,
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
          error: data.error || 'Connection test failed',
        });
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setTestResult({
        success: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        error: errorMessage,
      });
    } finally {
      setTesting(false);
    }
  };

  const handleEdit = (server: MCPServer) => {
    setEditingServer(server);
    setEditModalOpen(true);
  };

  const handleEditClose = () => {
    setEditModalOpen(false);
    setEditingServer(null);
  };

  const handleView = (server: MCPServer) => {
    setViewingServer(server);
    setViewModalOpen(true);
  };

  const handleDelete = (serverId: string) => {
    onDelete?.(serverId);
  };

  const getServerHealth = (server: MCPServer) => {
    const toolCount = server.tools?.length || 0;
    const transport = server.transport || (server.url ? 'http' : 'stdio');

    if (transport === 'stdio') {
      return {
        status: 'default' as const,
        text: 'Local process',
        color: '#8c8c8c',
      };
    }

    if (toolCount > 0) {
      return {
        status: 'success' as const,
        text: `${toolCount} tools`,
        color: '#52c41a',
      };
    }

    return {
      status: 'default' as const,
      text: 'Not tested',
      color: '#8c8c8c',
    };
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
      width: 120,
      render: (_: unknown, server: MCPServer) => {
        const health = getServerHealth(server);
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Badge status={health.status} />
            <Typography.Text style={{ fontSize: 12, color: health.color }}>
              {health.text}
            </Typography.Text>
          </div>
        );
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
        dataSource={mapToSortedArray(mcpServerById, (a, b) =>
          a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
        )}
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
        onCancel={resetCreateModal}
        okText={alreadyCreatedInOAuthFlow ? 'Done' : 'Create'}
        width={600}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields
            mode="create"
            transport={transport}
            onTransportChange={setTransport}
            authType={authType}
            onAuthTypeChange={setAuthType}
            form={createForm}
            client={client}
            onTestConnection={handleCreateTestConnection}
            testing={testing}
            testResult={testResult}
            onSaveFirst={handleSaveFirstForCreate}
          />
        </Form>
      </Modal>

      {/* Edit MCP Server Modal — self-contained */}
      <MCPServerEditModal
        server={editingServer}
        open={editModalOpen}
        client={client}
        onClose={handleEditClose}
      />

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
