import type { AgorClient } from '@agor-live/client';
import { ApiOutlined, DownOutlined } from '@ant-design/icons';
import type { FormInstance } from 'antd';
import {
  Alert,
  Badge,
  Button,
  Col,
  Collapse,
  Form,
  Input,
  Modal,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { extractOAuthConfigForTesting } from './mcp-oauth-utils';

const { TextArea } = Input;

export interface MCPServerFormFieldsProps {
  mode: 'create' | 'edit';
  transport?: 'stdio' | 'http' | 'sse';
  onTransportChange?: (transport: 'stdio' | 'http' | 'sse') => void;
  authType?: 'none' | 'bearer' | 'jwt' | 'oauth';
  onAuthTypeChange?: (authType: 'none' | 'bearer' | 'jwt' | 'oauth') => void;
  form: FormInstance;
  client: AgorClient | null;
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

/**
 * Reusable form fields for creating / editing an MCP server.
 *
 * Layout (top → bottom):
 *   1. Basic Information (open)        — name, display name, scope, enabled, description
 *   2. Connection (open)
 *      a. Transport + URL/command + Auth type + auth-specific KEY fields
 *      b. Connection action buttons (Test Auth, Start OAuth, Disconnect, Test Connection)
 *      c. Advanced (collapsed) — OAuth fields that are normally auto-discovered
 *   3. Environment variables (collapsed) — server-scoped JSON, last because it's
 *      orthogonal to "how I connect"
 */
export const MCPServerFormFields: React.FC<MCPServerFormFieldsProps> = ({
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

  // OAuth flow state
  const [oauthCallbackModalVisible, setOauthCallbackModalVisible] = useState(false);
  const [disconnectingOAuth, setDisconnectingOAuth] = useState(false);
  const oauthCompletedCleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      oauthCompletedCleanupRef.current?.();
    };
  }, []);

  // Track effective server ID (may differ from prop after onSaveFirst creates a new server)
  const [effectiveServerId, setEffectiveServerId] = useState<string | undefined>(serverId);
  useEffect(() => {
    setEffectiveServerId(serverId);
  }, [serverId]);

  // Watch advanced OAuth field values so we can show a "customized" dot on
  // the Advanced collapse header when any of them has a non-default value.
  const watchedAuthorizationUrl = Form.useWatch('oauth_authorization_url', form);
  const watchedTokenUrl = Form.useWatch('oauth_token_url', form);
  const watchedScope = Form.useWatch('oauth_scope', form);
  const watchedClientId = Form.useWatch('oauth_client_id', form);
  const watchedClientSecret = Form.useWatch('oauth_client_secret', form);
  const watchedOauthMode = Form.useWatch('oauth_mode', form);
  const watchedEnv = Form.useWatch('env', form);
  const hasEnvConfigured = typeof watchedEnv === 'string' && watchedEnv.trim().length > 0;
  const hasCustomizedAdvanced =
    [
      watchedAuthorizationUrl,
      watchedTokenUrl,
      watchedScope,
      watchedClientId,
      watchedClientSecret,
    ].some((v) => typeof v === 'string' && v.trim().length > 0) ||
    (typeof watchedOauthMode === 'string' && watchedOauthMode !== 'per_user');

  const handleStartOAuthFlow = async () => {
    if (!client) {
      showError('Client not available');
      return;
    }

    let targetServerId = effectiveServerId;
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

    const values = form.getFieldsValue(true);
    const requestData = extractOAuthConfigForTesting(values);
    if (!requestData) {
      showError('MCP URL is required');
      return;
    }

    setStartingOAuthFlow(true);

    const handleOpenBrowser = ({ authUrl }: { authUrl: string }) => {
      window.open(authUrl, '_blank', 'noopener,noreferrer');
    };
    client.io.on('oauth:open_browser', handleOpenBrowser);

    try {
      showInfo('Starting OAuth authentication flow...');

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
        setOauthCallbackModalVisible(true);
        showInfo('Authenticating... complete sign-in in the new tab.');

        const handleOAuthCompleted = (event: { state: string; success: boolean }) => {
          if (event.state === data.state && event.success) {
            showSuccess('OAuth authentication successful!');
            setOauthCallbackModalVisible(false);
            setOauthBrowserFlowAvailable(false);
            cleanup();
          }
        };
        const cleanup = () => {
          client.io.off('oauth:completed', handleOAuthCompleted);
          oauthCompletedCleanupRef.current = null;
        };
        oauthCompletedCleanupRef.current?.();
        oauthCompletedCleanupRef.current = cleanup;
        client.io.on('oauth:completed', handleOAuthCompleted);
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

    const values = form.getFieldsValue(true);
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
        showInfo('No authentication required - ready to use');
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      showError(`Connection test failed: ${errorMessage}`);
    } finally {
      setTestingAuth(false);
    }
  };

  const isRemoteTransport = transport !== 'stdio';
  const showAdvancedSection = isRemoteTransport && authType === 'oauth';

  // ── Basic Information section ──────────────────────────────────────
  const isCreate = mode === 'create';
  const basicChildren = (
    <>
      <Row gutter={16}>
        <Col span={12}>
          {isCreate ? (
            <Form.Item
              label="Name (Internal ID)"
              name="name"
              rules={[
                { required: true, message: 'Please enter a server name' },
                {
                  pattern: /^[a-z][a-z0-9_-]*$/,
                  message: 'Lowercase letters, digits, _ or - only; must start with a letter',
                },
                { max: 64, message: 'Maximum 64 characters' },
              ]}
              tooltip="Internal identifier - lowercase, no spaces (e.g., filesystem, sentry, context7)"
            >
              <Input placeholder="context7" />
            </Form.Item>
          ) : (
            <Form.Item
              label="Name (Internal ID)"
              name="name"
              tooltip="Internal identifier - cannot be changed after creation"
            >
              <Input disabled />
            </Form.Item>
          )}
        </Col>
        <Col span={12}>
          <Form.Item
            label={isCreate ? 'Display Name (Optional)' : 'Display Name'}
            name="display_name"
            tooltip="User-friendly name shown in UI (e.g., Context7 MCP)"
          >
            <Input placeholder={isCreate ? 'Context7 MCP' : 'Filesystem Access'} />
          </Form.Item>
        </Col>
      </Row>
      <Row gutter={16}>
        <Col span={12}>
          <Form.Item
            label="Scope"
            name="scope"
            initialValue={isCreate ? 'session' : 'global'}
            tooltip="Where this server is available"
          >
            <Select>
              <Select.Option value="global">Global (all sessions)</Select.Option>
              <Select.Option value="session">Session</Select.Option>
            </Select>
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item label="Enabled" name="enabled" valuePropName="checked" initialValue={true}>
            <Switch />
          </Form.Item>
        </Col>
      </Row>
      <Form.Item label="Description" name="description">
        <TextArea placeholder="Optional description..." rows={2} />
      </Form.Item>
    </>
  );

  // ── Connection section ─────────────────────────────────────────────
  const connectionChildren = (
    <>
      <Alert
        title={
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
                setOauthBrowserFlowAvailable(false);
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
                    oauth_authorization_url: undefined,
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
        </>
      )}

      {/* Connection action buttons — surfaced before secondary fields so they
          aren't buried under env vars or the OAuth advanced section. */}
      {(authType !== 'none' || isRemoteTransport) && (
        <Form.Item label="Actions" style={{ marginBottom: 16 }}>
          <Space wrap>
            {authType !== 'none' && (
              <Button type="default" loading={testingAuth} onClick={handleTestAuth}>
                Test Authentication
              </Button>
            )}
            {authType === 'oauth' && oauthBrowserFlowAvailable && (
              <Button type="primary" loading={startingOAuthFlow} onClick={handleStartOAuthFlow}>
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
            {isRemoteTransport && (
              <Button
                type="default"
                icon={<ApiOutlined />}
                onClick={onTestConnection}
                loading={testing}
              >
                {testing ? 'Testing...' : 'Test Connection'}
              </Button>
            )}
          </Space>
        </Form.Item>
      )}

      {/* Test connection result alerts (shown directly under the action buttons) */}
      {testResult?.success && (
        <div style={{ marginBottom: 16 }}>
          <Alert
            type="success"
            title={`Connected: ${testResult.toolCount} tools, ${testResult.resourceCount} resources, ${testResult.promptCount} prompts`}
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
                          <div style={{ opacity: 0.7, fontSize: 11 }}>{resource.mimeType}</div>
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
          title="Connection failed"
          description={testResult.error}
          showIcon
          style={{ marginBottom: 16 }}
        />
      )}

      {/* Advanced — long tail of OAuth endpoints that are normally
          auto-discovered. Collapsed by default; a dot on the header
          signals that one or more values have been customized. */}
      {showAdvancedSection && (
        <Collapse
          ghost
          // Keep panel children mounted when collapsed so Form.Items inside
          // don't lose their values (and Form.useWatch keeps reporting them).
          destroyOnHidden={false}
          expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
          items={[
            {
              key: 'advanced-oauth',
              // Force-render the panel so Form.Items inside (e.g. oauth_mode
              // with initialValue="per_user") register and apply their
              // defaults even when the user never expands the section.
              forceRender: true,
              label: (
                <Space size={8}>
                  <Typography.Text strong>Advanced — OAuth settings</Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    (auto-discovered when blank)
                  </Typography.Text>
                  {hasCustomizedAdvanced && (
                    <Tooltip title="Customized — one or more values overridden">
                      <Badge color="orange" />
                    </Tooltip>
                  )}
                </Space>
              ),
              children: (
                <>
                  <Alert
                    title="OAuth defaults are usually fine"
                    description={
                      <ul style={{ margin: 0, paddingLeft: 20, fontSize: 12 }}>
                        <li>
                          Modern OAuth 2.1 servers support discovery (RFC 8414 / RFC 9728) and
                          Dynamic Client Registration — leave everything here blank.
                        </li>
                        <li>
                          Set Client ID / Client Secret only for servers that require a
                          pre-registered OAuth app (e.g. Figma, GitHub).
                        </li>
                        <li>
                          Override the URLs only if the server doesn't expose a discovery document
                          or you need a non-default endpoint.
                        </li>
                      </ul>
                    }
                    type="info"
                    showIcon
                    style={{ marginBottom: 16 }}
                  />
                  <Form.Item
                    label="Client ID"
                    name="oauth_client_id"
                    tooltip="Required for servers that don't support Dynamic Client Registration (e.g. Figma, GitHub). Register an OAuth app with the provider and paste the client ID here. Leave blank to use DCR."
                  >
                    <Input
                      placeholder="Enter client ID or {{ user.env.OAUTH_CLIENT_ID }}"
                      allowClear
                    />
                  </Form.Item>
                  <Form.Item
                    label="Client Secret"
                    name="oauth_client_secret"
                    tooltip="Required for servers that use confidential clients (e.g. Figma). The secret is sent via HTTP Basic Auth during token exchange."
                  >
                    <Input.Password
                      placeholder="Enter client secret or {{ user.env.OAUTH_CLIENT_SECRET }}"
                      allowClear
                    />
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
                  <Form.Item
                    label="Authorization URL"
                    name="oauth_authorization_url"
                    tooltip="OAuth authorization endpoint for browser-based login. Leave empty for auto-discovery (RFC 8414)."
                  >
                    <Input placeholder="https://auth.example.com/oauth/authorize" allowClear />
                  </Form.Item>
                  <Form.Item
                    label="Token URL"
                    name="oauth_token_url"
                    tooltip="OAuth token endpoint. Leave empty for auto-discovery (OAuth 2.1 RFC 9728)"
                  >
                    <Input placeholder="Auto-detect or {{ user.env.OAUTH_TOKEN_URL }}" allowClear />
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
                </>
              ),
            },
          ]}
        />
      )}
    </>
  );

  const collapseItems = [
    {
      key: 'basic',
      label: <Typography.Text strong>Basic Information</Typography.Text>,
      children: basicChildren,
    },
    {
      key: 'connection',
      label: <Typography.Text strong>Connection</Typography.Text>,
      children: connectionChildren,
    },
    {
      key: 'env-vars',
      label: (
        <Space size={8}>
          <Typography.Text strong>Environment variables</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            (JSON, supports {`{{ user.env.VAR }}`} templates)
          </Typography.Text>
          {hasEnvConfigured && (
            <Tooltip title="One or more environment variables configured">
              <Badge color="orange" />
            </Tooltip>
          )}
        </Space>
      ),
      children: (
        <Form.Item
          name="env"
          tooltip="JSON object of environment variables. Values support templates like {{ user.env.VAR_NAME }}"
        >
          <TextArea
            placeholder='{"GITHUB_TOKEN": "{{ user.env.GITHUB_TOKEN }}", "ALLOWED_PATHS": "/path"}'
            rows={3}
          />
        </Form.Item>
      ),
    },
  ];

  return (
    <>
      <Collapse
        ghost
        // Keep panel children mounted when collapsed so Form.Items inside
        // don't lose their values (and Form.useWatch keeps reporting them).
        destroyOnHidden={false}
        defaultActiveKey={['basic', 'connection']}
        expandIcon={({ isActive }) => <DownOutlined rotate={isActive ? 180 : 0} />}
        items={collapseItems}
      />

      {/* OAuth waiting modal - closes automatically when daemon receives the callback */}
      <Modal
        title="OAuth Authentication"
        open={oauthCallbackModalVisible}
        onCancel={() => {
          setOauthCallbackModalVisible(false);
          oauthCompletedCleanupRef.current?.();
        }}
        footer={[
          <Button
            key="cancel"
            onClick={() => {
              setOauthCallbackModalVisible(false);
              oauthCompletedCleanupRef.current?.();
            }}
          >
            Cancel
          </Button>,
        ]}
      >
        <Space orientation="vertical" style={{ width: '100%' }}>
          <Typography.Paragraph>
            Waiting for authentication to complete in the browser tab...
          </Typography.Paragraph>
          <Typography.Paragraph>
            This dialog will close automatically once sign-in is complete.
          </Typography.Paragraph>
        </Space>
      </Modal>
    </>
  );
};
