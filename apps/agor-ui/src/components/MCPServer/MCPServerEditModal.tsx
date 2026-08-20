import type {
  AgorClient,
  MCPScope,
  MCPServer,
  MCPTransport,
  UpdateMCPServerInput,
} from '@agor-live/client';
import { Alert, Button, Form, Modal, Space, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useThemedMessage } from '@/utils/message';
import { MCPServerFormFields } from './MCPServerFormFields';
import {
  describeMissingForSave,
  firstFormErrorMessage,
  missingMCPFieldLabels,
  useFormRevision,
} from './mcp-form-requirements';
import { buildAuthFromValues, parseEnvJSON, parseHeadersJSON } from './mcp-oauth-utils';

export interface MCPServerEditModalProps {
  /** The server being edited. Modal opens when this is non-null and `open` is true. */
  server: MCPServer | null;
  open: boolean;
  client: AgorClient | null;
  /** Authenticated identity that owns the form contents and selected server. */
  identityKey: string | null;
  /** Current identity/role/auth generation, null while authority is unavailable. */
  authorityKey: string | null;
  /**
   * The transports this editor may switch to. Omit to offer all of them — a
   * caller that knows the user is held to remote transports passes those, so
   * the form does not invite a change the daemon will refuse.
   */
  offeredTransports?: MCPTransport[];
  /** The scopes this editor may switch to, on the same terms. */
  offeredScopes?: MCPScope[];
  /** Current server-side capability/connection decision from the owner. */
  mutationAllowed: boolean;
  mutationBlockedReason?: string;
  onClose: () => void;
  /** Runs after the portal has finished closing (for example, to restore focus). */
  afterClose?: () => void;
  /** Delegates focus restoration to an owner when the original trigger was unmounted. */
  focusTriggerAfterClose?: boolean;
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
 * both `MCPServersTable` (settings) and `SessionMcpFooterControl` (admin
 * shortcut).
 */
const MCPServerEditModalForIdentity: React.FC<MCPServerEditModalProps> = ({
  server,
  open,
  client,
  identityKey: _identityKey,
  authorityKey,
  offeredTransports,
  offeredScopes,
  mutationAllowed,
  mutationBlockedReason = 'You can no longer change this MCP server.',
  onClose,
  afterClose,
  focusTriggerAfterClose,
}) => {
  const { showSuccess, showError } = useThemedMessage();
  const [form] = Form.useForm();
  const [transport, setTransport] = useState<MCPTransport>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt' | 'oauth'>('none');
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [preserveAbsentDcrMode, setPreserveAbsentDcrMode] = useState(false);
  const [preserveAbsentCompatibilityMode, setPreserveAbsentCompatibilityMode] = useState(false);
  const [preserveAbsentGrantType, setPreserveAbsentGrantType] = useState(false);
  // The form is filled in an effect, so its fields read blank on the first
  // render. Gating on this keeps Save from flashing disabled while the modal
  // animates in.
  const [formHydrated, setFormHydrated] = useState(false);
  const [formRevision, bumpFormRevision] = useFormRevision();
  const identityActiveRef = useRef(true);
  useEffect(() => {
    identityActiveRef.current = true;
    return () => {
      identityActiveRef.current = false;
    };
  }, []);

  // Only ask the form once it is rendered and filled — an unmounted instance
  // warns, and a half-hydrated one would flash Save disabled.
  const missingRequiredFields =
    open && formHydrated
      ? missingMCPFieldLabels(form.getFieldsValue(true), { mode: 'edit', transport, authType })
      : [];
  const saveBlocked = !mutationAllowed || missingRequiredFields.length > 0;
  const mutationStateRef = useRef({ allowed: mutationAllowed, reason: mutationBlockedReason });
  mutationStateRef.current = { allowed: mutationAllowed, reason: mutationBlockedReason };

  // Hydrate the form when the modal opens or the user swaps to a different
  // server. Intentionally NOT keyed on `server` itself — that would clobber
  // in-progress edits whenever the parent's WebSocket sync re-emits the
  // record.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open || !server) return;

    setTestResult(null);
    setPreserveAbsentDcrMode(false);
    setPreserveAbsentCompatibilityMode(false);
    setPreserveAbsentGrantType(false);
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
      headers: server.headers ? JSON.stringify(server.headers, null, 2) : undefined,
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
      const managedCompatibilityMode = server.oauth_compatibility_policy?.managed_by_catalog
        ? server.oauth_compatibility_policy.effective_mode
        : undefined;
      setPreserveAbsentDcrMode(server.auth?.oauth_dcr_mode === undefined);
      setPreserveAbsentCompatibilityMode(server.auth?.oauth_compatibility_mode === undefined);
      setPreserveAbsentGrantType(server.auth?.oauth_grant_type === undefined);
      formValues.oauth_authorization_url = server.auth?.oauth_authorization_url;
      formValues.oauth_token_url = server.auth?.oauth_token_url;
      formValues.oauth_client_id = server.auth?.oauth_client_id;
      formValues.oauth_client_secret = server.auth?.oauth_client_secret;
      formValues.oauth_scope = server.auth?.oauth_scope;
      formValues.oauth_grant_type = server.auth?.oauth_grant_type || 'client_credentials';
      formValues.oauth_mode = server.auth?.oauth_mode || 'per_user';
      formValues.oauth_compatibility_mode =
        managedCompatibilityMode ?? server.auth?.oauth_compatibility_mode ?? 'strict';
      formValues.oauth_dcr_mode = server.auth?.oauth_dcr_mode || 'advertised';
    }

    form.setFieldsValue(formValues);
    setFormHydrated(true);
    bumpFormRevision();
  }, [
    open,
    server?.mcp_server_id,
    server?.oauth_compatibility_policy?.effective_mode,
    server?.oauth_compatibility_policy?.managed_by_catalog,
    form,
  ]);

  const closeAndReset = () => {
    form.resetFields();
    setTransport('stdio');
    setAuthType('none');
    setTestResult(null);
    setPreserveAbsentDcrMode(false);
    setPreserveAbsentCompatibilityMode(false);
    setPreserveAbsentGrantType(false);
    setFormHydrated(false);
    onClose();
  };

  const handleTestConnection = async () => {
    if (!identityActiveRef.current) return;
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
    try {
      await form.validateFields(['headers']);
    } catch {
      if (!identityActiveRef.current) return;
      showError('Please fix custom HTTP headers before testing');
      return;
    }
    if (!identityActiveRef.current) return;

    setTesting(true);
    setTestResult(null);

    try {
      const data = (await client.service('mcp-servers/discover').create({
        mcp_server_id: server.mcp_server_id,
        url: values.url,
        transport: values.transport || 'http',
        auth: buildAuthFromValues(values, {
          preserveAbsentDcrMode,
          preserveAbsentCompatibilityMode,
          preserveAbsentGrantType,
        }),
        headers: parseHeadersJSON(values.headers),
      })) as {
        success: boolean;
        error?: string;
        capabilities?: { tools: number; resources: number; prompts: number };
        tools?: Array<{ name: string; description: string }>;
        resources?: Array<{ name: string; uri: string; mimeType?: string }>;
        prompts?: Array<{ name: string; description: string }>;
      };

      if (!identityActiveRef.current) return;

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
      if (!identityActiveRef.current) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setTestResult({
        success: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        error: errorMessage,
      });
    } finally {
      if (identityActiveRef.current) setTesting(false);
    }
  };

  const saveFormValues = async (): Promise<boolean> => {
    if (!server || !client || !identityActiveRef.current) return false;
    if (!mutationStateRef.current.allowed) {
      showError(mutationStateRef.current.reason);
      return false;
    }

    try {
      await form.validateFields();
      if (!identityActiveRef.current || !mutationStateRef.current.allowed) {
        showError(mutationStateRef.current.reason);
        return false;
      }
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
        updates.headers = parseHeadersJSON(values.headers);
      }

      const env = parseEnvJSON(values.env);
      if (env) updates.env = env;

      updates.auth = buildAuthFromValues(values, {
        preserveAbsentDcrMode,
        preserveAbsentCompatibilityMode,
        preserveAbsentGrantType,
      });

      if (!identityActiveRef.current || !mutationStateRef.current.allowed) {
        showError(mutationStateRef.current.reason);
        return false;
      }
      await client.service('mcp-servers').patch(server.mcp_server_id, updates);
      return identityActiveRef.current;
    } catch (error) {
      if (!identityActiveRef.current) return false;
      // Name the field, rather than letting a rejected validation surface as
      // the generic message its non-Error shape would produce.
      const errorMessage =
        firstFormErrorMessage(error) ??
        (error instanceof Error ? error.message : 'Failed to update server');
      showError(errorMessage);
      return false;
    }
  };

  const handleSave = async () => {
    if (await saveFormValues()) {
      if (!identityActiveRef.current) return;
      showSuccess('MCP server updated successfully');
      closeAndReset();
    }
  };

  const prepareOAuthStart = async (): Promise<string | null> => {
    if (!(await saveFormValues())) return null;
    return server?.mcp_server_id ?? null;
  };

  return (
    <Modal
      title="Edit MCP Server"
      open={open}
      onCancel={closeAndReset}
      afterClose={afterClose}
      focusable={focusTriggerAfterClose === undefined ? undefined : { focusTriggerAfterClose }}
      width={600}
      destroyOnHidden
      footer={
        <Space>
          <Button onClick={closeAndReset}>Cancel</Button>
          {/* A disabled button can't host a tooltip of its own — hence the span. */}
          <Tooltip
            title={
              !mutationAllowed
                ? mutationBlockedReason
                : saveBlocked
                  ? describeMissingForSave(missingRequiredFields)
                  : undefined
            }
          >
            <span>
              <Button type="primary" disabled={saveBlocked} onClick={handleSave}>
                Save
              </Button>
            </span>
          </Tooltip>
        </Space>
      }
    >
      {!mutationAllowed && (
        <Alert
          type="warning"
          showIcon
          title="MCP server changes are unavailable"
          description={mutationBlockedReason}
          style={{ marginTop: 16 }}
        />
      )}
      <Form
        form={form}
        layout="vertical"
        style={{ marginTop: 16 }}
        onValuesChange={(changedValues) => {
          if ('oauth_dcr_mode' in changedValues) setPreserveAbsentDcrMode(false);
          if ('oauth_compatibility_mode' in changedValues) {
            setPreserveAbsentCompatibilityMode(false);
          }
          if ('oauth_grant_type' in changedValues) setPreserveAbsentGrantType(false);
          bumpFormRevision();
        }}
      >
        <MCPServerFormFields
          offeredTransports={offeredTransports}
          offeredScopes={offeredScopes}
          mode="edit"
          transport={transport}
          onTransportChange={setTransport}
          authType={authType}
          onAuthTypeChange={setAuthType}
          form={form}
          client={client}
          authorityKey={authorityKey}
          serverId={server?.mcp_server_id}
          onTestConnection={handleTestConnection}
          testing={testing}
          testResult={testResult}
          onPrepareOAuthStart={prepareOAuthStart}
          mutationAllowed={mutationAllowed}
          mutationBlockedReason={mutationBlockedReason}
          formRevision={formRevision}
          managedOAuthCompatibilityMode={
            server?.oauth_compatibility_policy?.managed_by_catalog &&
            (server.oauth_compatibility_policy.effective_mode === 'strict' ||
              server.oauth_compatibility_policy.effective_mode === 'marketplace')
              ? server.oauth_compatibility_policy.effective_mode
              : undefined
          }
        />
      </Form>
    </Modal>
  );
};

/**
 * The form can contain raw OAuth/JWT/bearer credentials. Remount its entire
 * state owner when the authenticated identity changes so another same-role
 * caller cannot inherit a selected row or any registered Ant Form value.
 * `authorityKey` remains a finer mutation gate; it intentionally does not key
 * this owner, preserving same-user reconnect and token-refresh edits.
 */
export const MCPServerEditModal: React.FC<MCPServerEditModalProps> = (props) => (
  <MCPServerEditModalForIdentity
    key={props.identityKey ?? '__no-authenticated-user__'}
    {...props}
  />
);
