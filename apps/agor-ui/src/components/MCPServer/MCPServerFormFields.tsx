import type { AgorClient, MCPScope, MCPTransport } from '@agor-live/client';
import { MCP_SCOPES, MCP_TRANSPORTS } from '@agor-live/client';
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
  Popconfirm,
  Row,
  Select,
  Space,
  Switch,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '@/utils/message';
import { sanitizeSecretValue } from '@/utils/sanitizeSecret';
import { MCPOAuthRecoveryAlert } from './MCPOAuthRecoveryAlert';
import { describeMissingForOAuth, missingMCPFieldLabels } from './mcp-form-requirements';
import { extractOAuthConfigForTesting, validateHeadersJSON } from './mcp-oauth-utils';
import { useMCPServerOAuthStart } from './useMCPServerOAuthStart';

const { TextArea } = Input;

function isRemoteTransportValue(transport?: MCPTransport): boolean {
  return transport !== 'stdio';
}

const TRANSPORT_LABELS: Record<MCPTransport, string> = {
  stdio: 'stdio (Local process)',
  http: 'HTTP',
  sse: 'SSE (Server-Sent Events)',
};

const ALL_TRANSPORTS: MCPTransport[] = [...MCP_TRANSPORTS];

const SCOPE_LABELS: Record<MCPScope, string> = {
  global: 'Global (all sessions)',
  session: 'Session',
};

const ALL_SCOPES: MCPScope[] = [...MCP_SCOPES];

export interface MCPServerFormFieldsProps {
  mode: 'create' | 'edit';
  transport?: MCPTransport;
  onTransportChange?: (transport: MCPTransport) => void;
  /**
   * The transports this user may configure. Omit to offer all of them — the
   * daemon still decides, so this only keeps a form from being filled in
   * towards a refusal.
   */
  offeredTransports?: MCPTransport[];
  /** The scopes this user may configure, on the same terms as the transports. */
  offeredScopes?: MCPScope[];
  authType?: 'none' | 'bearer' | 'jwt' | 'oauth';
  onAuthTypeChange?: (authType: 'none' | 'bearer' | 'jwt' | 'oauth') => void;
  form: FormInstance;
  client: AgorClient | null;
  /** Current identity/role/auth generation, null while authority is unavailable. */
  authorityKey: string | null;
  serverId?: string;
  onTestConnection?: () => Promise<void>;
  testing?: boolean;
  testResult?: {
    success: boolean;
    toolCount: number;
    resourceCount: number;
    promptCount: number;
    error?: string;
    tools?: Array<{ name: string; description?: string }>;
    resources?: Array<{ name: string; uri: string; mimeType?: string }>;
    prompts?: Array<{ name: string; description?: string }>;
  } | null;
  /** Persist current settings and return the authoritative server ID before every OAuth start. */
  onPrepareOAuthStart: () => Promise<string | null>;
  /** Whether persistent mutations/OAuth preparation remain authorized. */
  mutationAllowed?: boolean;
  mutationBlockedReason?: string;
  /**
   * Changes whenever the owner's form values do. The connection actions read
   * the form store directly, so they need a reason to re-render — see
   * `useFormRevision`.
   */
  formRevision?: number;
  /** Effective catalog-managed policy shown read-only in Settings. */
  managedOAuthCompatibilityMode?: 'strict' | 'marketplace';
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
  offeredTransports = ALL_TRANSPORTS,
  offeredScopes = ALL_SCOPES,
  authType = 'none',
  onAuthTypeChange,
  form,
  client,
  authorityKey,
  serverId,
  onTestConnection,
  testing = false,
  testResult,
  onPrepareOAuthStart,
  mutationAllowed = true,
  mutationBlockedReason = 'You can no longer change this MCP server.',
  // Consumed by re-rendering, not by reading — see `formRevision` above.
  formRevision: _formRevision,
  managedOAuthCompatibilityMode,
}) => {
  const { showSuccess, showError, showWarning, showInfo } = useThemedMessage();
  const [testingAuth, setTestingAuth] = useState(false);
  const [oauthBrowserFlowAvailable, setOauthBrowserFlowAvailable] = useState(false);
  const [oauthAdvancedOpen, setOauthAdvancedOpen] = useState(false);

  const [disconnectingOAuth, setDisconnectingOAuth] = useState(false);
  const oauthStartAllowed = mutationAllowed && authorityKey !== null;
  const operationGuard = useAuthorityOperationGuard(
    oauthStartAllowed ? [authorityKey, client, mutationAllowed] : null
  );

  // `Start OAuth Flow` writes the server row before it redirects, so it needs
  // everything a save needs — not just the URL it puts in the request. Read
  // from the store the save itself reads; `formRevision` is what re-renders us.
  const missingRequiredFields = missingMCPFieldLabels(form.getFieldsValue(true), {
    mode,
    transport,
    authType,
  });

  const {
    cancelOAuthWait,
    clearOAuthFailure,
    handleStartOAuthFlow,
    oauthCallbackModalVisible,
    oauthFailure,
    startingOAuthFlow,
  } = useMCPServerOAuthStart({
    client,
    authorityKey,
    onPrepareOAuthStart,
    onOAuthSucceeded: () => setOauthBrowserFlowAvailable(false),
    showError,
    showInfo,
    showSuccess,
    startAllowed: oauthStartAllowed,
    startBlockedReason: mutationBlockedReason,
  });

  // Watch advanced OAuth field values so we can show a "customized" dot on
  // the Advanced collapse header when any of them has a non-default value.
  const watchedAuthorizationUrl = Form.useWatch('oauth_authorization_url', form);
  const watchedTokenUrl = Form.useWatch('oauth_token_url', form);
  const watchedScope = Form.useWatch('oauth_scope', form);
  const watchedClientId = Form.useWatch('oauth_client_id', form);
  const watchedClientSecret = Form.useWatch('oauth_client_secret', form);
  const watchedOauthMode = Form.useWatch('oauth_mode', form);
  const watchedCompatibilityMode = Form.useWatch('oauth_compatibility_mode', form);
  const watchedDcrMode = Form.useWatch('oauth_dcr_mode', form);
  const watchedEnv = Form.useWatch('env', form);
  const watchedHeaders = Form.useWatch('headers', form);
  const hasEnvConfigured = typeof watchedEnv === 'string' && watchedEnv.trim().length > 0;
  const hasHeadersConfigured =
    isRemoteTransportValue(transport) &&
    typeof watchedHeaders === 'string' &&
    watchedHeaders.trim().length > 0;
  const hasCustomizedAdvanced =
    [
      watchedAuthorizationUrl,
      watchedTokenUrl,
      watchedScope,
      watchedClientId,
      watchedClientSecret,
    ].some((v) => typeof v === 'string' && v.trim().length > 0) ||
    (typeof watchedOauthMode === 'string' && watchedOauthMode !== 'per_user') ||
    watchedCompatibilityMode === 'legacy' ||
    (typeof watchedDcrMode === 'string' && watchedDcrMode !== 'advertised');

  const handleDisconnectOAuth = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    if (!mutationAllowed) {
      showError(mutationBlockedReason);
      return;
    }
    if (!client) {
      showError('Client not available');
      return;
    }
    if (!serverId) {
      showError('Cannot disconnect: MCP server must be saved first');
      return;
    }

    setDisconnectingOAuth(true);
    try {
      const data = (await client.service('mcp-servers/oauth-disconnect').create({
        mcp_server_id: serverId,
      })) as { success: boolean; message?: string; error?: string };
      if (!operation.isCurrent()) return;

      if (data.success) {
        showSuccess(data.message || 'OAuth connection removed');
        setOauthBrowserFlowAvailable(true);
      } else {
        showError(data.error || 'Failed to disconnect OAuth');
      }
    } catch {
      if (!operation.isCurrent()) return;
      showError('OAuth disconnect failed. Check the connection and try again.');
    } finally {
      if (operation.isCurrent()) setDisconnectingOAuth(false);
    }
  };

  const handleTestAuth = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
    if (!client) {
      showError('Client not available');
      return;
    }

    const values = form.getFieldsValue(true);
    const currentAuthType = values.auth_type || authType;
    if (currentAuthType === 'oauth') clearOAuthFailure();

    setTestingAuth(true);
    try {
      if (currentAuthType === 'jwt') {
        const apiUrl = values.jwt_api_url;
        const apiToken =
          typeof values.jwt_api_token === 'string'
            ? sanitizeSecretValue(values.jwt_api_token)
            : values.jwt_api_token;
        const apiSecret =
          typeof values.jwt_api_secret === 'string'
            ? sanitizeSecretValue(values.jwt_api_secret)
            : values.jwt_api_secret;

        if (!apiUrl || !apiToken || !apiSecret) {
          showError('Please fill in all JWT authentication fields');
          return;
        }

        const data = (await client.service('mcp-servers/test-jwt').create({
          api_url: apiUrl,
          api_token: apiToken,
          api_secret: apiSecret,
        })) as { success: boolean; error?: string };
        if (!operation.isCurrent()) return;

        if (data.success) {
          showSuccess('JWT authentication successful - token received');
        } else {
          showError(data.error || 'JWT authentication failed');
        }
      } else if (currentAuthType === 'oauth') {
        const requestData = extractOAuthConfigForTesting({
          ...values,
          ...(serverId && managedOAuthCompatibilityMode ? { mcp_server_id: serverId } : {}),
        });
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
        if (!operation.isCurrent()) return;

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
    } catch {
      if (!operation.isCurrent()) return;
      showError('Connection test failed. Check the saved configuration and try again.');
    } finally {
      if (operation.isCurrent()) setTestingAuth(false);
    }
  };

  // One label for both the live and the blocked button, so a retry still reads
  // as a retry while it waits on a field.
  const oauthStartLabel = oauthFailure?.recovery
    ? 'Save OAuth settings & retry'
    : oauthFailure
      ? 'Retry OAuth Flow'
      : 'Start OAuth Flow';

  const isRemoteTransport = isRemoteTransportValue(transport);
  const showAdvancedSection = isRemoteTransport && authType === 'oauth';
  const savedSecretExtra = (formField: string) =>
    mode === 'edit' ? (
      <Space size={8} wrap>
        <Typography.Text type="secondary">
          Leaving this blank preserves the saved secret.
        </Typography.Text>
        <Button
          size="small"
          danger
          onClick={() => {
            form.setFieldValue(formField, '');
            form.setFieldValue(`${formField}_clear`, true);
          }}
        >
          Clear saved secret
        </Button>
      </Space>
    ) : undefined;

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
            tooltip={
              offeredScopes.includes('global')
                ? 'Where this server is available'
                : "Where this server is available. A workspace-wide server is admin-managed under this workspace's MCP policy."
            }
          >
            <Select
              options={offeredScopes.map((value) => ({ value, label: SCOPE_LABELS[value] }))}
            />
          </Form.Item>
        </Col>
        <Col span={12}>
          <Form.Item
            label="Enabled"
            name="enabled"
            valuePropName="checked"
            initialValue={true}
            extra={
              mode === 'edit' && authType === 'oauth'
                ? 'Disabling removes the saved OAuth connection from Agor. Re-enabling requires a new sign-in.'
                : undefined
            }
          >
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
        initialValue={mode === 'create' ? offeredTransports[0] : undefined}
        tooltip={
          offeredTransports.includes('stdio')
            ? 'Connection method: stdio for local processes, HTTP/SSE for remote servers'
            : 'Connection method. A stdio server runs a command on the executor host, which only admins can configure.'
        }
      >
        <Select
          options={offeredTransports.map((value) => ({ value, label: TRANSPORT_LABELS[value] }))}
          onChange={(value) => onTransportChange?.(value as MCPTransport)}
        />
      </Form.Item>

      {transport === 'stdio' ? (
        <>
          <Form.Item
            label="Command"
            name="command"
            // Required in both modes: a stdio server with no command is as
            // unusable after an edit as it would be on creation.
            rules={[{ required: true, message: 'Please enter a command' }]}
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
            rules={[{ required: true, message: 'Please enter a URL' }]}
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
                clearOAuthFailure();
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
                mode === 'create'
                  ? [{ required: true, message: 'Please enter a bearer token' }]
                  : []
              }
              tooltip="Bearer token. Supports templates like {{ user.env.API_TOKEN }}"
              extra={savedSecretExtra('auth_token')}
            >
              <Input.Password
                placeholder="{{ user.env.API_TOKEN }} or raw token"
                onChange={() => form.setFieldValue('auth_token_clear', false)}
              />
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
                rules={
                  mode === 'create'
                    ? [{ required: true, message: 'Please enter the API token' }]
                    : []
                }
                tooltip="JWT API token. Supports templates like {{ user.env.JWT_TOKEN }}"
                extra={savedSecretExtra('jwt_api_token')}
              >
                <Input.Password
                  placeholder="{{ user.env.JWT_TOKEN }} or raw token"
                  onChange={() => form.setFieldValue('jwt_api_token_clear', false)}
                />
              </Form.Item>
              <Form.Item
                label="API Secret"
                name="jwt_api_secret"
                rules={
                  mode === 'create'
                    ? [{ required: true, message: 'Please enter the API secret' }]
                    : []
                }
                tooltip="JWT API secret. Supports templates like {{ user.env.JWT_SECRET }}"
                extra={savedSecretExtra('jwt_api_secret')}
              >
                <Input.Password
                  placeholder="{{ user.env.JWT_SECRET }} or raw secret"
                  onChange={() => form.setFieldValue('jwt_api_secret_clear', false)}
                />
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
            {authType === 'oauth' &&
              oauthBrowserFlowAvailable &&
              (!oauthStartAllowed || missingRequiredFields.length > 0 ? (
                // Disabled rather than hidden: the user has already earned this
                // button with a successful auth test, so it has to say what is
                // still holding it back.
                <Tooltip
                  title={
                    !oauthStartAllowed
                      ? mutationBlockedReason
                      : describeMissingForOAuth(missingRequiredFields)
                  }
                >
                  <span>
                    <Button type="primary" disabled>
                      {oauthStartLabel}
                    </Button>
                  </span>
                </Tooltip>
              ) : (
                <Button type="primary" loading={startingOAuthFlow} onClick={handleStartOAuthFlow}>
                  {oauthStartLabel}
                </Button>
              ))}
            {authType === 'oauth' && serverId && !oauthBrowserFlowAvailable && (
              <Popconfirm
                title="Disconnect this OAuth connection?"
                description="This removes the saved connection from Agor. Provider-side access may remain until you revoke it with the provider."
                okText="Disconnect"
                okButtonProps={{ danger: true }}
                disabled={!mutationAllowed}
                onConfirm={handleDisconnectOAuth}
              >
                <Button
                  type="default"
                  danger
                  loading={disconnectingOAuth}
                  disabled={!mutationAllowed}
                >
                  Disconnect OAuth
                </Button>
              </Popconfirm>
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

      {oauthFailure && <MCPOAuthRecoveryAlert failure={oauthFailure} />}

      {/* Advanced — long tail of OAuth endpoints that are normally
          auto-discovered. Collapsed by default; a dot on the header
          signals that one or more values have been customized. */}
      {showAdvancedSection && (
        <Collapse
          ghost
          activeKey={oauthAdvancedOpen ? ['advanced-oauth'] : []}
          onChange={(activeKey) => {
            setOauthAdvancedOpen(
              Array.isArray(activeKey)
                ? activeKey.includes('advanced-oauth')
                : activeKey === 'advanced-oauth'
            );
          }}
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
                          {managedOAuthCompatibilityMode
                            ? `The current Catalog entry manages this server's ${managedOAuthCompatibilityMode === 'marketplace' ? 'interoperability' : 'strict'} discovery policy.`
                            : 'Strict MCP OAuth discovery is enabled by default.'}{' '}
                          Protected-resource binding, PKCE S256, and issuer checks remain enabled.
                        </li>
                        <li>
                          Set Client ID / Client Secret only for servers that require a
                          pre-registered OAuth app.
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
                    tooltip="Register an OAuth app with the provider and paste its client ID. Otherwise Agor can use a registration endpoint advertised by the provider."
                  >
                    <Input
                      placeholder="Enter client ID or {{ user.env.OAUTH_CLIENT_ID }}"
                      allowClear
                    />
                  </Form.Item>
                  <Form.Item
                    label="Dynamic Client Registration"
                    name="oauth_dcr_mode"
                    initialValue="advertised"
                    tooltip="Advertised registration uses only validated provider metadata. Legacy fallback additionally guesses an issuer-relative /register endpoint."
                  >
                    <Select>
                      <Select.Option value="advertised">
                        Advertised endpoint (recommended)
                      </Select.Option>
                      <Select.Option value="disabled">
                        Disabled — pre-registered client
                      </Select.Option>
                      <Select.Option value="fallback">Legacy /register fallback</Select.Option>
                    </Select>
                  </Form.Item>
                  <Form.Item
                    label="OAuth Compatibility"
                    name="oauth_compatibility_mode"
                    initialValue="strict"
                    tooltip={
                      managedOAuthCompatibilityMode
                        ? 'This effective policy is managed by the current curated Catalog entry. Editing the endpoint or authentication configuration makes that catalog policy stop applying.'
                        : 'Legacy mode narrowly permits older discovery and metadata deviations. It never relaxes outbound network protections.'
                    }
                  >
                    <Select disabled={!!managedOAuthCompatibilityMode}>
                      {managedOAuthCompatibilityMode === 'marketplace' && (
                        <Select.Option value="marketplace">
                          Catalog compatibility (managed)
                        </Select.Option>
                      )}
                      <Select.Option value="strict">
                        Strict current MCP OAuth
                        {managedOAuthCompatibilityMode === 'strict' ? ' (catalog managed)' : ''}
                      </Select.Option>
                      <Select.Option value="legacy">Legacy provider compatibility</Select.Option>
                    </Select>
                  </Form.Item>
                  <Form.Item
                    label="Client Secret"
                    name="oauth_client_secret"
                    tooltip="Required for servers that use confidential clients. The secret is sent via HTTP Basic Auth during token exchange."
                    extra={savedSecretExtra('oauth_client_secret')}
                  >
                    <Input.Password
                      placeholder="Enter client secret or {{ user.env.OAUTH_CLIENT_SECRET }}"
                      allowClear
                      onChange={() => form.setFieldValue('oauth_client_secret_clear', false)}
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
      key: 'advanced-config',
      label: (
        <Space size={8}>
          <Typography.Text strong>Advanced Configuration</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            (headers and environment variables)
          </Typography.Text>
          {(hasHeadersConfigured || hasEnvConfigured) && (
            <Tooltip title="Advanced configuration set">
              <Badge color="orange" />
            </Tooltip>
          )}
        </Space>
      ),
      children: (
        <>
          {isRemoteTransport && (
            <Form.Item
              label="Custom HTTP Headers"
              name="headers"
              tooltip="JSON object of additional headers for HTTP/SSE transports. Values support templates like {{ user.env.DATADOG_API_KEY }}. Authorization is configured via Auth Type, not here."
              rules={[
                {
                  validator: async (_, value) => {
                    const error = validateHeadersJSON(value);
                    if (error) throw new Error(error);
                  },
                },
              ]}
            >
              <TextArea
                placeholder='{"DD-API-KEY": "{{ user.env.DATADOG_API_KEY }}", "X-Datadog-Parent-Org-Id": "123"}'
                rows={3}
              />
            </Form.Item>
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
        </>
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
        onCancel={cancelOAuthWait}
        footer={[
          <Button key="cancel" onClick={cancelOAuthWait}>
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
