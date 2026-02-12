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
import { extractOAuthConfig, extractOAuthConfigForTesting } from './mcp-oauth-utils';

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
  authType?: 'none' | 'bearer' | 'jwt' | 'oauth';
  onAuthTypeChange?: (authType: 'none' | 'bearer' | 'jwt' | 'oauth') => void;
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
    error?: string;
    tools?: Array<{ name: string; description: string }>;
    resources?: Array<{ name: string; uri: string; mimeType?: string }>;
    prompts?: Array<{ name: string; description: string }>;
  } | null;
  /** Callback to save server first before OAuth flow (for new servers) */
  onSaveFirst?: () => Promise<string | null>;
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
  onSaveFirst,
}) => {
  const { showSuccess, showError, showWarning, showInfo } = useThemedMessage();
  const [testingAuth, setTestingAuth] = useState(false);
  const [oauthBrowserFlowAvailable, setOauthBrowserFlowAvailable] = useState(false);
  const [startingOAuthFlow, setStartingOAuthFlow] = useState(false);

  // Two-phase OAuth flow state
  const [oauthCallbackModalVisible, setOauthCallbackModalVisible] = useState(false);
  const [oauthCallbackUrl, setOauthCallbackUrl] = useState('');
  const [_oauthState, setOauthState] = useState<string | null>(null);
  const [completingOAuth, setCompletingOAuth] = useState(false);
  const [disconnectingOAuth, setDisconnectingOAuth] = useState(false);

  // Track effective server ID (may differ from prop after onSaveFirst creates a new server)
  const [effectiveServerId, setEffectiveServerId] = useState<string | undefined>(serverId);
  useEffect(() => {
    setEffectiveServerId(serverId);
  }, [serverId]);

  // Start the browser-based OAuth 2.1 flow (two-phase for remote daemon)
  const handleStartOAuthFlow = async () => {
    if (!client) {
      showError('Client not available');
      return;
    }

    // Track the target server ID (may be set after saving)
    let targetServerId = effectiveServerId;

    // If no serverId and we have onSaveFirst callback, save the server first
    if (!targetServerId && onSaveFirst) {
      showInfo('Saving MCP server before testing...');
      const newServerId = await onSaveFirst();
      if (!newServerId) {
        showError('Failed to save MCP server');
        return;
      }
      targetServerId = newServerId;
      setEffectiveServerId(newServerId);
    }

    const values = form.getFieldsValue();
    const requestData = extractOAuthConfigForTesting(values);
    if (!requestData) {
      showError('MCP URL is required');
      return;
    }

    setStartingOAuthFlow(true);

    // Set up listener for oauth:open_browser event from daemon
    const handleOpenBrowser = ({ authUrl }: { authUrl: string }) => {
      console.log('[OAuth] Received open_browser event, opening:', authUrl);
      window.open(authUrl, '_blank', 'noopener,noreferrer');
    };
    client.io.on('oauth:open_browser', handleOpenBrowser);

    try {
      showInfo('Starting OAuth authentication flow...');

      // Use the new two-phase OAuth flow
      const data = (await client.service('mcp-servers/oauth-start').create({
        mcp_url: requestData.mcp_url,
        mcp_server_id: targetServerId,
        client_id: requestData.client_id,
      })) as {
        success: boolean;
        error?: string;
        message?: string;
        authorizationUrl?: string;
        state?: string;
      };

      if (data.success && data.state) {
        // Store the state for completing the flow
        setOauthState(data.state);
        setOauthCallbackUrl('');
        setOauthCallbackModalVisible(true);
        showInfo('Browser opened. Complete authentication, then paste the callback URL.');
      } else {
        showError(data.error || 'Failed to start OAuth flow');
      }
    } catch (error) {
      showError(`OAuth flow error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      client.io.off('oauth:open_browser', handleOpenBrowser);
      setStartingOAuthFlow(false);
    }
  };

  // Complete OAuth flow with callback URL
  const handleCompleteOAuthFlow = async () => {
    if (!client || !oauthCallbackUrl.trim()) {
      showError('Please paste the callback URL');
      return;
    }

    setCompletingOAuth(true);
    try {
      const data = (await client.service('mcp-servers/oauth-complete').create({
        callback_url: oauthCallbackUrl.trim(),
      })) as {
        success: boolean;
        error?: string;
        message?: string;
      };

      if (data.success) {
        showSuccess(data.message || 'OAuth authentication successful!');
        setOauthCallbackModalVisible(false);
        setOauthBrowserFlowAvailable(false);
        setOauthState(null);
        setOauthCallbackUrl('');
      } else {
        showError(data.error || 'Failed to complete OAuth flow');
      }
    } catch (error) {
      showError(`OAuth error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setCompletingOAuth(false);
    }
  };

  // Disconnect OAuth - remove stored tokens
  const handleDisconnectOAuth = async () => {
    if (!client) {
      showError('Client not available');
      return;
    }

    if (!effectiveServerId) {
      showError('Cannot disconnect: MCP server must be saved first');
      return;
    }

    setDisconnectingOAuth(true);
    try {
      const data = (await client.service('mcp-servers/oauth-disconnect').create({
        mcp_server_id: effectiveServerId,
      })) as { success: boolean; message?: string; error?: string };

      if (data.success) {
        showSuccess(data.message || 'OAuth connection removed');
        // Show the "Start OAuth Flow" button again so user can re-authenticate
        setOauthBrowserFlowAvailable(true);
      } else {
        showError(data.error || 'Failed to disconnect OAuth');
      }
    } catch (error) {
      showError(`Disconnect error: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setDisconnectingOAuth(false);
    }
  };

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
      } else if (currentAuthType === 'oauth') {
        const requestData = extractOAuthConfigForTesting(values);
        if (!requestData) {
          showWarning('Please enter MCP URL first to test OAuth authentication');
          return;
        }

        const data = (await client.service('mcp-servers/test-oauth').create(requestData)) as {
          success: boolean;
          error?: string;
          message?: string;
          oauthType?: string;
          tokenValid?: boolean;
          mcpStatus?: number;
          mcpStatusText?: string;
          tokenUrlSource?: string;
          requiresBrowserFlow?: boolean;
          metadataUrl?: string;
          authorizationServers?: string[];
          wwwAuthenticate?: string;
          responseHeaders?: Record<string, string>;
          hint?: string;
          debugInfo?: unknown;
        };

        if (data.success) {
          if (data.requiresBrowserFlow) {
            // OAuth 2.1 detected but needs browser authentication
            setOauthBrowserFlowAvailable(true);
            showInfo(
              data.message ||
                'OAuth 2.1 detected. Click "Start OAuth Flow" to authenticate in browser.'
            );
          } else if (data.oauthType === 'none') {
            setOauthBrowserFlowAvailable(false);
            showSuccess('MCP server accessible without authentication');
          } else {
            let message = data.message || 'OAuth authentication successful';
            if (data.tokenUrlSource === 'auto-detected') {
              message += ' (token URL auto-detected)';
            }
            if (data.mcpStatus !== undefined) {
              message += ` | MCP server responded with ${data.mcpStatus}`;
            }
            showSuccess(message);
          }
        } else {
          // Show detailed error with hints
          let errorMsg = data.error || 'OAuth authentication failed';
          if (data.hint) {
            errorMsg += `\n\nHint: ${data.hint}`;
          }
          showError(errorMsg);
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
                  onChange={(value) => {
                    // Reset OAuth flow state when changing auth type
                    setOauthBrowserFlowAvailable(false);

                    // Clear fields from other auth types to prevent validation issues
                    if (value !== 'jwt') {
                      form.setFieldsValue({
                        jwt_api_url: undefined,
                        jwt_api_token: undefined,
                        jwt_api_secret: undefined,
                      });
                    }
                    if (value !== 'bearer') {
                      form.setFieldsValue({ auth_token: undefined });
                    }
                    if (value !== 'oauth') {
                      form.setFieldsValue({
                        oauth_token_url: undefined,
                        oauth_client_id: undefined,
                        oauth_client_secret: undefined,
                        oauth_scope: undefined,
                      });
                    }
                    onAuthTypeChange?.(value as 'none' | 'bearer' | 'jwt' | 'oauth');
                  }}
                >
                  <Select.Option value="none">None</Select.Option>
                  <Select.Option value="bearer">Bearer Token</Select.Option>
                  <Select.Option value="jwt">JWT</Select.Option>
                  <Select.Option value="oauth">OAuth 2.1</Select.Option>
                </Select>
              </Form.Item>

              {authType === 'bearer' && (
                <Form.Item
                  label="Token"
                  name="auth_token"
                  rules={
                    authType === 'bearer'
                      ? [{ required: true, message: 'Please enter a bearer token' }]
                      : []
                  }
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
                    rules={
                      authType === 'jwt'
                        ? [{ required: true, message: 'Please enter the API URL' }]
                        : []
                    }
                    tooltip="JWT auth API URL. Supports templates."
                  >
                    <Input placeholder="https://auth.example.com/token" />
                  </Form.Item>

                  <Form.Item
                    label="API Token"
                    name="jwt_api_token"
                    rules={
                      authType === 'jwt'
                        ? [{ required: true, message: 'Please enter the API token' }]
                        : []
                    }
                    tooltip="JWT API token. Supports templates like {{ user.env.JWT_TOKEN }}"
                  >
                    <Input.Password placeholder="{{ user.env.JWT_TOKEN }} or raw token" />
                  </Form.Item>

                  <Form.Item
                    label="API Secret"
                    name="jwt_api_secret"
                    rules={
                      authType === 'jwt'
                        ? [{ required: true, message: 'Please enter the API secret' }]
                        : []
                    }
                    tooltip="JWT API secret. Supports templates like {{ user.env.JWT_SECRET }}"
                  >
                    <Input.Password placeholder="{{ user.env.JWT_SECRET }} or raw secret" />
                  </Form.Item>
                </>
              )}

              {authType === 'oauth' && (
                <>
                  <Form.Item
                    label="Token URL"
                    name="oauth_token_url"
                    tooltip="OAuth token endpoint. Leave empty for auto-discovery (OAuth 2.1 RFC 9728)"
                  >
                    <Input placeholder="Auto-detect or {{ user.env.OAUTH_TOKEN_URL }}" allowClear />
                  </Form.Item>

                  <Form.Item
                    label="Client ID"
                    name="oauth_client_id"
                    tooltip="OAuth client ID. Supports templates like {{ user.env.OAUTH_CLIENT_ID }}"
                  >
                    <Input placeholder="{{ user.env.OAUTH_CLIENT_ID }}" allowClear />
                  </Form.Item>

                  <Form.Item
                    label="Client Secret"
                    name="oauth_client_secret"
                    tooltip="OAuth client secret. Supports templates like {{ user.env.OAUTH_CLIENT_SECRET }}"
                  >
                    <Input.Password placeholder="{{ user.env.OAUTH_CLIENT_SECRET }}" allowClear />
                  </Form.Item>

                  <Form.Item
                    label="Scope"
                    name="oauth_scope"
                    tooltip="Optional: OAuth scopes (space-separated, e.g., 'read write')"
                  >
                    <Input placeholder="Leave empty or specify scopes" allowClear />
                  </Form.Item>

                  <Form.Item
                    label="Grant Type"
                    name="oauth_grant_type"
                    initialValue="client_credentials"
                    tooltip="OAuth grant type for Client Credentials flow. OAuth 2.1 auto-discovery uses Authorization Code with PKCE instead."
                  >
                    <Select disabled>
                      <Select.Option value="client_credentials">Client Credentials</Select.Option>
                    </Select>
                  </Form.Item>

                  <Form.Item
                    label="OAuth Mode"
                    name="oauth_mode"
                    initialValue="per_user"
                    tooltip="Per User: Each user authenticates separately (recommended). Shared: One token for all users."
                  >
                    <Select>
                      <Select.Option value="per_user">
                        Per User (each user authenticates) - Recommended
                      </Select.Option>
                      <Select.Option value="shared">
                        Shared (single token for all users)
                      </Select.Option>
                    </Select>
                  </Form.Item>

                  <Alert
                    message="OAuth 2.1 Auto-Discovery"
                    description={
                      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                        <li>
                          All fields are optional - OAuth 2.1 servers advertise their endpoints
                        </li>
                        <li>MCP server returns metadata URL in WWW-Authenticate header</li>
                        <li>Browser opens automatically for user authentication (PKCE flow)</li>
                        <li>Only fill Client ID/Secret for legacy Client Credentials flow</li>
                      </ul>
                    }
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                  />
                </>
              )}

              {authType !== 'none' && (
                <Form.Item>
                  <Space>
                    <Button type="default" loading={testingAuth} onClick={handleTestAuth}>
                      Test Authentication
                    </Button>
                    {authType === 'oauth' && oauthBrowserFlowAvailable && (
                      <Button
                        type="primary"
                        loading={startingOAuthFlow}
                        onClick={handleStartOAuthFlow}
                      >
                        Start OAuth Flow
                      </Button>
                    )}
                    {authType === 'oauth' && effectiveServerId && !oauthBrowserFlowAvailable && (
                      <Button
                        type="default"
                        danger
                        loading={disconnectingOAuth}
                        onClick={handleDisconnectOAuth}
                      >
                        Disconnect OAuth
                      </Button>
                    )}
                  </Space>
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

                {testResult?.success && (
                  <div style={{ marginTop: 8 }}>
                    <Alert
                      type="success"
                      message={`Connected: ${testResult.toolCount} tools, ${testResult.resourceCount} resources, ${testResult.promptCount} prompts`}
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
                    description={testResult.error}
                    showIcon
                    style={{ marginTop: 8 }}
                  />
                )}
              </Space>
            </div>
          )}
        </>
      ),
    },
  ];

  return (
    <>
      <Collapse
        ghost
        defaultActiveKey={['basic']}
        expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
        items={collapseItems}
      />

      {/* OAuth Callback URL Modal - for two-phase OAuth flow */}
      <Modal
        title="Complete OAuth Authentication"
        open={oauthCallbackModalVisible}
        onCancel={() => {
          setOauthCallbackModalVisible(false);
          setOauthState(null);
          setOauthCallbackUrl('');
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setOauthCallbackModalVisible(false);
              setOauthState(null);
              setOauthCallbackUrl('');
            }}
          >
            Cancel
          </Button>,
          <Button
            key="complete"
            type="primary"
            onClick={handleCompleteOAuthFlow}
            loading={completingOAuth}
            disabled={!oauthCallbackUrl.trim()}
          >
            Complete Authentication
          </Button>,
        ]}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>
            After signing in to the OAuth provider, you will be redirected to a page that may show
            an error (like "This site can't be reached"). This is expected.
          </Typography.Paragraph>

          <Typography.Paragraph strong>
            Copy the entire URL from your browser's address bar and paste it below:
          </Typography.Paragraph>

          <Input.TextArea
            placeholder="http://127.0.0.1:xxxxx/oauth/callback?code=...&state=..."
            value={oauthCallbackUrl}
            onChange={(e) => setOauthCallbackUrl(e.target.value)}
            rows={3}
            style={{ fontFamily: 'monospace', fontSize: 12 }}
          />

          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            The URL should contain "code=" and "state=" parameters.
          </Typography.Text>
        </Space>
      </Modal>
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
  const { showSuccess, showError } = useThemedMessage();
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [viewingServer, setViewingServer] = useState<MCPServer | null>(null);
  const [form] = Form.useForm();
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt' | 'oauth'>('none');
  const [testing, setTesting] = useState(false);
  // Track if server was already created by onSaveFirst during OAuth flow
  const [alreadyCreatedInOAuthFlow, setAlreadyCreatedInOAuthFlow] = useState(false);
  const [testResult, setTestResult] = useState<{
    success: boolean;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    error?: string;
    tools?: Array<{ name: string; description: string }>;
    resources?: Array<{ name: string; uri: string; mimeType?: string }>;
    prompts?: Array<{ name: string; description: string }>;
  } | null>(null);

  // Sync editing server when mcpServerById updates (real-time WebSocket updates)
  useEffect(() => {
    if (editingServer && mcpServerById.has(editingServer.mcp_server_id)) {
      const updatedServer = mcpServerById.get(editingServer.mcp_server_id);
      if (updatedServer && updatedServer !== editingServer) {
        setEditingServer(updatedServer);
      }
    }
  }, [mcpServerById, editingServer]);

  // Save server first for OAuth flow in create mode (returns new server ID)
  const handleSaveFirstForCreate = async (): Promise<string | null> => {
    if (!client) return null;
    try {
      const values = await form.validateFields();
      const data: CreateMCPServerInput = {
        name: values.name,
        display_name: values.display_name,
        description: values.description,
        transport: values.transport,
        scope: values.scope || 'global',
        enabled: values.enabled ?? true,
        source: 'user',
      };

      if (values.transport === 'stdio') {
        data.command = values.command;
        data.args = values.args?.split(',').map((arg: string) => arg.trim()) || [];
      } else {
        data.url = values.url;
      }

      if (values.auth_type && values.auth_type !== 'none') {
        data.auth = { type: values.auth_type };
        if (values.auth_type === 'bearer') {
          data.auth.token = values.auth_token;
        } else if (values.auth_type === 'jwt') {
          data.auth.api_url = values.jwt_api_url;
          data.auth.api_token = values.jwt_api_token;
          data.auth.api_secret = values.jwt_api_secret;
        } else if (values.auth_type === 'oauth') {
          const oauthConfig = extractOAuthConfig(values);
          Object.assign(data.auth, oauthConfig);
        }
      }

      if (values.env) {
        try {
          data.env = JSON.parse(values.env);
        } catch {
          // Invalid JSON, skip
        }
      }

      const result = await client.service('mcp-servers').create(data);
      setAlreadyCreatedInOAuthFlow(true);
      return (result as MCPServer).mcp_server_id || null;
    } catch {
      return null;
    }
  };

  const handleCreate = () => {
    // If server was already created during OAuth flow, just close the modal
    if (alreadyCreatedInOAuthFlow) {
      form.resetFields();
      setCreateModalOpen(false);
      setTransport('stdio');
      setAuthType('none');
      setTestResult(null);
      setAlreadyCreatedInOAuthFlow(false);
      return;
    }

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
          } else if (values.auth_type === 'oauth') {
            // Extract OAuth config using helper (only includes non-empty fields)
            const oauthConfig = extractOAuthConfig(values);
            Object.assign(data.auth, oauthConfig);
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
        setAuthType('none');
        setTestResult(null);
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

  // Test connection using current form values (inline config, no save required)
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
            type: 'none' | 'bearer' | 'jwt' | 'oauth';
            token?: string;
            api_url?: string;
            api_token?: string;
            api_secret?: string;
            oauth_token_url?: string;
            oauth_client_id?: string;
            oauth_client_secret?: string;
            oauth_scope?: string;
            oauth_grant_type?: string;
            oauth_mode?: 'per_user' | 'shared';
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
        } else if (values.auth_type === 'oauth') {
          // Extract OAuth config using helper
          const oauthConfig = extractOAuthConfig(values);
          Object.assign(auth, oauthConfig);
        }
      }

      // Send form values for testing using inline config
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

      // Include server ID to persist discovered capabilities (only for saved servers)
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
        const errorMsg = data.error || 'Connection test failed';
        setTestResult({
          success: false,
          toolCount: 0,
          resourceCount: 0,
          promptCount: 0,
          error: errorMsg,
        });
        showError(errorMsg);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.error('Connection test failed:', error);
      setTestResult({
        success: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        error: errorMessage,
      });
      showError(`Connection test failed: ${errorMessage}`);
    } finally {
      setTesting(false);
    }
  };

  const handleEdit = async (server: MCPServer) => {
    setEditingServer(server);
    setTestResult(null); // Reset test result when opening edit modal
    const serverAuthType = (server.auth?.type as 'none' | 'bearer' | 'jwt' | 'oauth') || 'none';
    setAuthType(serverAuthType);

    // Set transport state for conditional rendering
    setTransport(server.transport || (server.url ? 'http' : 'stdio'));

    // Reset form first to clear any stale registered fields from previous edits
    // This prevents Ant Design from validating hidden fields (e.g. JWT fields when auth is OAuth)
    form.resetFields();

    // Set form fields - only include auth fields relevant to the current auth type
    const formValues: Record<string, unknown> = {
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
      tool_permissions: server.tool_permissions || {},
    };

    // Only set auth fields for the active auth type to avoid
    // Ant Design registering and validating hidden fields
    if (serverAuthType === 'bearer') {
      formValues.auth_token = server.auth?.token;
    } else if (serverAuthType === 'jwt') {
      formValues.jwt_api_url = server.auth?.api_url;
      formValues.jwt_api_token = server.auth?.api_token;
      formValues.jwt_api_secret = server.auth?.api_secret;
    } else if (serverAuthType === 'oauth') {
      formValues.oauth_token_url = server.auth?.oauth_token_url;
      formValues.oauth_client_id = server.auth?.oauth_client_id;
      formValues.oauth_client_secret = server.auth?.oauth_client_secret;
      formValues.oauth_scope = server.auth?.oauth_scope;
      formValues.oauth_grant_type = server.auth?.oauth_grant_type || 'client_credentials';
      formValues.oauth_mode = server.auth?.oauth_mode || 'per_user';
    }

    form.setFieldsValue(formValues);

    setEditModalOpen(true);
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
        } else if (values.auth_type === 'oauth') {
          // Extract OAuth config using helper (only includes non-empty fields)
          const oauthConfig = extractOAuthConfig(values);
          Object.assign(updates.auth, oauthConfig);
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
      setTransport('stdio');
      setAuthType('none');
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
          setAlreadyCreatedInOAuthFlow(false);
        }}
        okText={alreadyCreatedInOAuthFlow ? 'Done' : 'Create'}
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
            onSaveFirst={handleSaveFirstForCreate}
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
          setTransport('stdio');
          setAuthType('none');
          setTestResult(null);
        }}
        okText="Save"
        width={600}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields
            mode="edit"
            transport={transport}
            onTransportChange={setTransport}
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
