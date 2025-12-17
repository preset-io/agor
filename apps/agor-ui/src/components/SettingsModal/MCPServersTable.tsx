import type { CreateMCPServerInput, MCPServer, UpdateMCPServerInput } from '@agor/core/types';
import {
  ApiOutlined,
  DeleteOutlined,
  DownOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
} from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  Alert,
  Badge,
  Button,
  Collapse,
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
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useState } from 'react';
import { mapToArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';

const { TextArea } = Input;

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
  serverId?: string;
  onTestConnection?: () => Promise<void>;
  testing?: boolean;
  testResult?: {
    success: boolean;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    tools?: Array<{ name: string; description: string }>;
    resources?: Array<{ name: string; uri: string; mimeType?: string }>;
    prompts?: Array<{ name: string; description: string }>;
  } | null;
}

const MCPServerFormFields: React.FC<MCPServerFormFieldsProps> = ({
  mode,
  transport,
  onTransportChange,
  authType = 'none',
  onAuthTypeChange,
  form,
  client,
  serverId,
  onTestConnection,
  testing = false,
  testResult,
}) => {
  const { showSuccess, showError, showWarning, showInfo } = useThemedMessage();
  const [testingAuth, setTestingAuth] = useState(false);

  const handleTestAuth = async () => {
    if (!client) {
      showError('Client not available');
      return;
    }

    const values = form.getFieldsValue();
    const currentAuthType = values.auth_type || authType;

    setTestingAuth(true);
    try {
      if (currentAuthType === 'jwt') {
        const apiUrl = values.jwt_api_url;
        const apiToken = values.jwt_api_token;
        const apiSecret = values.jwt_api_secret;

        if (!apiUrl || !apiToken || !apiSecret) {
          showError('Please fill in all JWT authentication fields');
          return;
        }

        // Use Feathers client for authenticated request
        const data = (await client.service('mcp-servers/test-jwt').create({
          api_url: apiUrl,
          api_token: apiToken,
          api_secret: apiSecret,
        })) as { success: boolean; error?: string };

        if (data.success) {
          showSuccess('JWT authentication successful - token received');
        } else {
          showError(data.error || 'JWT authentication failed');
        }
      } else if (currentAuthType === 'bearer') {
        const token = values.auth_token;
        if (token) {
          showSuccess('Bearer token configured');
        } else {
          showWarning('No bearer token provided');
        }
      } else {
        // Auth type is 'none' - just confirm the configuration
        showInfo('No authentication required - ready to use');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showError(`Connection test failed: ${errorMessage}`);
    } finally {
      setTestingAuth(false);
    }
  };

  const collapseItems = [
    // Basic Info - always shown, not in collapse
    ...(mode === 'create'
      ? [
          {
            key: 'basic',
            label: <Typography.Text strong>Basic Information</Typography.Text>,
            children: (
              <>
                <Form.Item
                  label="Name (Internal ID)"
                  name="name"
                  rules={[{ required: true, message: 'Please enter a server name' }]}
                  tooltip="Internal identifier - lowercase, no spaces (e.g., filesystem, sentry, context7)"
                >
                  <Input placeholder="context7" />
                </Form.Item>

                <Form.Item
                  label="Scope"
                  name="scope"
                  initialValue="session"
                  tooltip="Where this server is available"
                >
                  <Select>
                    <Select.Option value="global">Global (all sessions)</Select.Option>
                    <Select.Option value="session">Session</Select.Option>
                  </Select>
                </Form.Item>

                <Form.Item
                  label="Display Name (Optional)"
                  name="display_name"
                  tooltip="User-friendly name shown in UI (e.g., Context7 MCP)"
                >
                  <Input placeholder="Context7 MCP" />
                </Form.Item>

                <Form.Item
                  label="Enabled"
                  name="enabled"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Switch />
                </Form.Item>

                <Form.Item label="Description" name="description">
                  <TextArea placeholder="Optional description..." rows={2} />
                </Form.Item>
              </>
            ),
          },
        ]
      : [
          {
            key: 'basic',
            label: <Typography.Text strong>Basic Information</Typography.Text>,
            children: (
              <>
                <Form.Item
                  label="Name (Internal ID)"
                  name="name"
                  tooltip="Internal identifier - cannot be changed after creation"
                >
                  <Input disabled />
                </Form.Item>

                <Form.Item
                  label="Scope"
                  name="scope"
                  initialValue="global"
                  tooltip="Where this server is available"
                >
                  <Select>
                    <Select.Option value="global">Global (all sessions)</Select.Option>
                    <Select.Option value="session">Session</Select.Option>
                  </Select>
                </Form.Item>

                <Form.Item label="Display Name" name="display_name">
                  <Input placeholder="Filesystem Access" />
                </Form.Item>

                <Form.Item
                  label="Enabled"
                  name="enabled"
                  valuePropName="checked"
                  initialValue={true}
                >
                  <Switch />
                </Form.Item>

                <Form.Item label="Description" name="description">
                  <TextArea placeholder="Optional description..." rows={2} />
                </Form.Item>
              </>
            ),
          },
        ]),
    {
      key: 'connection',
      label: <Typography.Text strong>Connection</Typography.Text>,
      children: (
        <>
          <Alert
            message={
              <>
                Use <Typography.Text code>{'{{ user.env.VAR }}'}</Typography.Text> to inject your
                environment variables.
              </>
            }
            type="info"
            showIcon
            style={{ marginBottom: 16 }}
          />

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

          {transport === 'stdio' ? (
            <>
              <Form.Item
                label="Command"
                name="command"
                rules={
                  mode === 'create' ? [{ required: true, message: 'Please enter a command' }] : []
                }
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
                tooltip="Server URL. Supports templates like {{ user.env.MCP_URL }}"
              >
                <Input placeholder="https://mcp.example.com" />
              </Form.Item>

              <Form.Item
                label="Auth Type"
                name="auth_type"
                initialValue="none"
                tooltip="Authentication method for the MCP server"
              >
                <Select
                  onChange={(value) => onAuthTypeChange?.(value as 'none' | 'bearer' | 'jwt')}
                >
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
                  tooltip="Bearer token. Supports templates like {{ user.env.API_TOKEN }}"
                >
                  <Input.Password placeholder="{{ user.env.API_TOKEN }} or raw token" />
                </Form.Item>
              )}

              {authType === 'jwt' && (
                <>
                  <Form.Item
                    label="API URL"
                    name="jwt_api_url"
                    rules={[{ required: true, message: 'Please enter the API URL' }]}
                    tooltip="JWT auth API URL. Supports templates."
                  >
                    <Input placeholder="https://auth.example.com/token" />
                  </Form.Item>

                  <Form.Item
                    label="API Token"
                    name="jwt_api_token"
                    rules={[{ required: true, message: 'Please enter the API token' }]}
                    tooltip="JWT API token. Supports templates like {{ user.env.JWT_TOKEN }}"
                  >
                    <Input.Password placeholder="{{ user.env.JWT_TOKEN }} or raw token" />
                  </Form.Item>

                  <Form.Item
                    label="API Secret"
                    name="jwt_api_secret"
                    rules={[{ required: true, message: 'Please enter the API secret' }]}
                    tooltip="JWT API secret. Supports templates like {{ user.env.JWT_SECRET }}"
                  >
                    <Input.Password placeholder="{{ user.env.JWT_SECRET }} or raw secret" />
                  </Form.Item>
                </>
              )}

              {authType !== 'none' && (
                <Form.Item>
                  <Button type="default" loading={testingAuth} onClick={handleTestAuth}>
                    Test Authentication
                  </Button>
                </Form.Item>
              )}
            </>
          )}

          <Form.Item
            label="Environment Variables"
            name="env"
            tooltip="JSON object of environment variables. Values support templates like {{ user.env.VAR_NAME }}"
          >
            <TextArea
              placeholder='{"GITHUB_TOKEN": "{{ user.env.GITHUB_TOKEN }}", "ALLOWED_PATHS": "/path"}'
              rows={3}
            />
          </Form.Item>

          {/* Test Connection - only for HTTP/SSE transport */}
          {transport !== 'stdio' && (
            <>
              <div style={{ borderTop: '1px solid #303030', marginTop: 16, paddingTop: 16 }}>
                <Space direction="vertical" style={{ width: '100%' }}>
                  <Button
                    type="default"
                    icon={<ApiOutlined />}
                    onClick={onTestConnection}
                    loading={testing}
                  >
                    {testing ? 'Testing...' : 'Test Connection'}
                  </Button>

                  {testResult && testResult.success && (
                    <div style={{ marginTop: 8 }}>
                      <Alert
                        type="success"
                        message={`Connected: ${testResult.toolCount} tools, ${testResult.resourceCount} resources`}
                        showIcon
                        style={{ marginBottom: 8 }}
                      />
                      {testResult.tools && testResult.tools.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                          >
                            Tools:
                          </Typography.Text>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {testResult.tools.map((tool) => (
                              <Tooltip
                                key={tool.name}
                                title={tool.description || 'No description'}
                                placement="top"
                              >
                                <Tag color="blue" style={{ marginBottom: 4, cursor: 'help' }}>
                                  {tool.name}
                                </Tag>
                              </Tooltip>
                            ))}
                          </div>
                        </div>
                      )}
                      {testResult.resources && testResult.resources.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                          >
                            Resources:
                          </Typography.Text>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {testResult.resources.map((resource) => (
                              <Tooltip
                                key={resource.uri}
                                title={
                                  <div>
                                    <div>{resource.uri}</div>
                                    {resource.mimeType && (
                                      <div style={{ opacity: 0.7, fontSize: 11 }}>
                                        {resource.mimeType}
                                      </div>
                                    )}
                                  </div>
                                }
                                placement="top"
                              >
                                <Tag color="cyan" style={{ marginBottom: 4, cursor: 'help' }}>
                                  {resource.name}
                                </Tag>
                              </Tooltip>
                            ))}
                          </div>
                        </div>
                      )}
                      {testResult.prompts && testResult.prompts.length > 0 && (
                        <div style={{ marginTop: 8 }}>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12, display: 'block', marginBottom: 4 }}
                          >
                            Prompts:
                          </Typography.Text>
                          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                            {testResult.prompts.map((prompt) => (
                              <Tooltip
                                key={prompt.name}
                                title={prompt.description || 'No description'}
                                placement="top"
                              >
                                <Tag color="purple" style={{ marginBottom: 4, cursor: 'help' }}>
                                  {prompt.name}
                                </Tag>
                              </Tooltip>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {testResult && !testResult.success && (
                    <Alert
                      type="error"
                      message="Connection failed"
                      showIcon
                      style={{ marginTop: 8 }}
                    />
                  )}
                </Space>
              </div>
            </>
          )}
        </>
      ),
    },
  ];

  return (
    <Collapse
      ghost
      defaultActiveKey={['basic']}
      expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
      items={collapseItems}
    />
  );
};

export const MCPServersTable: React.FC<MCPServersTableProps> = ({
  mcpServerById,
  client,
  onCreate,
  onUpdate,
  onDelete,
}) => {
  const { showSuccess, showError } = useThemedMessage();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [viewingServer, setViewingServer] = useState<MCPServer | null>(null);
  const [form] = Form.useForm();
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt'>('none');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    tools?: Array<{ name: string; description: string }>;
    resources?: Array<{ name: string; uri: string; mimeType?: string }>;
    prompts?: Array<{ name: string; description: string }>;
  } | null>(null);

  // Sync editing server when mcpServerById updates (real-time WebSocket updates)
  useEffect(() => {
    if (editingServer && mcpServerById.has(editingServer.mcp_server_id)) {
      const updatedServer = mcpServerById.get(editingServer.mcp_server_id);
      if (updatedServer && updatedServer !== editingServer) {
        console.log('[MCP] Server updated via WebSocket, refreshing edit modal', {
          serverId: String(editingServer.mcp_server_id).substring(0, 8),
        });
        setEditingServer(updatedServer);
      }
    }
  }, [mcpServerById, editingServer]);

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
        console.error('Form validation failed:', error);
        // Error fields are shown inline by Ant Design Form
        if (error.errorFields && error.errorFields.length > 0) {
          const firstError = error.errorFields[0];
          showError(firstError.errors[0] || 'Please fill in required fields');
        }
      });
  };

  // Test connection using current form values (not saved config)
  // If serverId is provided, capabilities will be persisted after successful test
  const handleTestConnection = async (serverId?: string) => {
    if (!client) {
      showError('Client not available');
      return;
    }

    const values = form.getFieldsValue();

    // Validate required fields for connection test
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
      // Build auth config from form values
      let auth:
        | {
            type: 'none' | 'bearer' | 'jwt';
            token?: string;
            api_url?: string;
            api_token?: string;
            api_secret?: string;
          }
        | undefined;

      if (values.auth_type && values.auth_type !== 'none') {
        auth = { type: values.auth_type };
        if (values.auth_type === 'bearer') {
          auth.token = values.auth_token;
        } else if (values.auth_type === 'jwt') {
          auth.api_url = values.jwt_api_url;
          auth.api_token = values.jwt_api_token;
          auth.api_secret = values.jwt_api_secret;
        }
      }

      // Send form values for testing (optionally with serverId to persist results)
      const requestData: {
        mcp_server_id?: string;
        url: string;
        transport: 'http' | 'sse';
        auth?: typeof auth;
      } = {
        url: values.url,
        transport: values.transport || 'http',
        auth,
      };

      // Include server ID if editing existing server (to persist discovered capabilities)
      if (serverId) {
        requestData.mcp_server_id = serverId;
      }

      const data = (await client.service('mcp-servers/discover').create(requestData)) as {
        success: boolean;
        error?: string;
        capabilities?: { tools: number; resources: number; prompts: number };
        tools?: Array<{ name: string; description: string }>;
        resources?: Array<{ name: string; uri: string; mimeType?: string }>;
        prompts?: Array<{ name: string; description: string }>;
      };

      if (data.success && data.capabilities) {
        const result = {
          success: true,
          toolCount: data.capabilities.tools,
          resourceCount: data.capabilities.resources,
          promptCount: data.capabilities.prompts,
          tools: data.tools,
          resources: data.resources,
          prompts: data.prompts,
        };
        setTestResult(result);
        showSuccess(
          `Connection successful: ${result.toolCount} tools, ${result.resourceCount} resources, ${result.promptCount} prompts`
        );
      } else {
        setTestResult({ success: false, toolCount: 0, resourceCount: 0, promptCount: 0 });
        showError(data.error || 'Connection test failed');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Connection test failed:', error);
      setTestResult({ success: false, toolCount: 0, resourceCount: 0, promptCount: 0 });
      showError(`Connection test failed: ${errorMessage}`);
    } finally {
      setTesting(false);
    }
  };

  const handleEdit = async (server: MCPServer) => {
    console.log('[MCP] handleEdit called with server:', {
      name: server.name,
      mcp_server_id: String(server.mcp_server_id).substring(0, 8),
    });

    setEditingServer(server);
    setTestResult(null); // Reset test result when opening edit modal
    const serverAuthType = (server.auth?.type as 'none' | 'bearer' | 'jwt') || 'none';
    setAuthType(serverAuthType);

    // Set transport state for conditional rendering
    if (server.transport) {
      setTransport(server.transport);
    }

    // Set form fields
    form.setFieldsValue({
      name: server.name,
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
    });

    setEditModalOpen(true);
    console.log('[MCP] Edit modal opened for server:', server.name, {
      transport: server.transport,
    });
  };

  const handleUpdate = async () => {
    if (!editingServer || !client) return;

    try {
      const values = await form.validateFields();

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

      // Save the updates
      await client.service('mcp-servers').patch(editingServer.mcp_server_id, updates);

      // Also call parent callback for state management
      onUpdate?.(editingServer.mcp_server_id, updates);

      showSuccess('MCP server updated successfully');

      // Close the modal after successful update
      form.resetFields();
      setEditModalOpen(false);
      setEditingServer(null);
      setTestResult(null);
    } catch (error) {
      // Validation or update failed
      console.error('Update failed:', error);
      const errorMessage = error instanceof Error ? error.message : 'Failed to update server';
      showError(errorMessage);
    }
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

    // For stdio servers, tools are only available when session is running
    if (transport === 'stdio') {
      return {
        status: 'default' as const,
        text: 'Local process',
        color: '#8c8c8c',
      };
    }

    // For HTTP/SSE servers, show tool count if tested
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
          setTestResult(null);
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
            onTestConnection={() => handleTestConnection()}
            testing={testing}
            testResult={testResult}
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
          setTestResult(null);
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
            serverId={editingServer?.mcp_server_id}
            onTestConnection={
              editingServer ? () => handleTestConnection(editingServer.mcp_server_id) : undefined
            }
            testing={testing}
            testResult={testResult}
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
