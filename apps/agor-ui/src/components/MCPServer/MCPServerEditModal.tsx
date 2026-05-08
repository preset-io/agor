import type { AgorClient, MCPServer, UpdateMCPServerInput } from '@agor-live/client';
import { Form, Modal } from 'antd';
import { useEffect, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { MCPServerFormFields } from './MCPServerFormFields';
import { buildAuthFromValues, parseEnvJSON } from './mcp-oauth-utils';

export interface MCPServerEditModalProps {
  /** The server being edited. Modal opens when this is non-null and `open` is true. */
  server: MCPServer | null;
  open: boolean;
  client: AgorClient | null;
  onClose: () => void;
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

/**
 * Self-contained "Edit MCP Server" modal.
 *
 * Hydrates its own form from `server`, owns transport/authType/test state,
 * and persists updates via the `mcp-servers` Feathers service. Used by
 * both `MCPServersTable` (settings) and `MCPServerPill` (admin shortcut).
 */
export const MCPServerEditModal: React.FC<MCPServerEditModalProps> = ({
  server,
  open,
  client,
  onClose,
}) => {
  const { showSuccess, showError } = useThemedMessage();
  const [form] = Form.useForm();
  const [transport, setTransport] = useState<'stdio' | 'http' | 'sse'>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt' | 'oauth'>('none');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);

  // Hydrate the form when the modal opens or the user swaps to a different
  // server. Intentionally NOT keyed on `server` itself — that would clobber
  // in-progress edits whenever the parent's WebSocket sync re-emits the
  // record.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open || !server) return;

    setTestResult(null);
    const serverAuthType = (server.auth?.type as 'none' | 'bearer' | 'jwt' | 'oauth') || 'none';
    setAuthType(serverAuthType);
    setTransport(server.transport || (server.url ? 'http' : 'stdio'));

    // Reset first to clear any stale fields registered for a different auth type.
    form.resetFields();

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
    };

    // Only set fields for the active auth type to avoid AntD validating hidden fields.
    if (serverAuthType === 'bearer') {
      formValues.auth_token = server.auth?.token;
    } else if (serverAuthType === 'jwt') {
      formValues.jwt_api_url = server.auth?.api_url;
      formValues.jwt_api_token = server.auth?.api_token;
      formValues.jwt_api_secret = server.auth?.api_secret;
    } else if (serverAuthType === 'oauth') {
      formValues.oauth_authorization_url = server.auth?.oauth_authorization_url;
      formValues.oauth_token_url = server.auth?.oauth_token_url;
      formValues.oauth_client_id = server.auth?.oauth_client_id;
      formValues.oauth_client_secret = server.auth?.oauth_client_secret;
      formValues.oauth_scope = server.auth?.oauth_scope;
      formValues.oauth_grant_type = server.auth?.oauth_grant_type || 'client_credentials';
      formValues.oauth_mode = server.auth?.oauth_mode || 'per_user';
    }

    form.setFieldsValue(formValues);
  }, [open, server?.mcp_server_id, form]);

  const closeAndReset = () => {
    form.resetFields();
    setTransport('stdio');
    setAuthType('none');
    setTestResult(null);
    onClose();
  };

  const handleTestConnection = async () => {
    if (!client || !server) {
      // Pre-flight failure — no inline result UI yet, so a toast is the
      // only signal we have. Result-bearing failures below set testResult
      // and rely on the inline alert (no duplicate toast).
      showError('Client not available');
      return;
    }

    const values = form.getFieldsValue(true);

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
        mcp_server_id: server.mcp_server_id,
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

  const handleSave = async () => {
    if (!server || !client) return;

    try {
      await form.validateFields();
      const values = form.getFieldsValue(true);

      const updates: UpdateMCPServerInput = {
        display_name: values.display_name,
        description: values.description,
        scope: values.scope,
        enabled: values.enabled,
        transport: values.transport,
      };

      if (values.transport === 'stdio') {
        updates.command = values.command;
        updates.args = values.args?.split(',').map((arg: string) => arg.trim()) || [];
      } else {
        updates.url = values.url;
      }

      const env = parseEnvJSON(values.env);
      if (env) updates.env = env;

      updates.auth = buildAuthFromValues(values);

      await client.service('mcp-servers').patch(server.mcp_server_id, updates);

      showSuccess('MCP server updated successfully');
      closeAndReset();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Failed to update server';
      showError(errorMessage);
    }
  };

  return (
    <Modal
      title="Edit MCP Server"
      open={open}
      onOk={handleSave}
      onCancel={closeAndReset}
      okText="Save"
      width={600}
      destroyOnHidden
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
          serverId={server?.mcp_server_id}
          onTestConnection={handleTestConnection}
          testing={testing}
          testResult={testResult}
        />
      </Form>
    </Modal>
  );
};
