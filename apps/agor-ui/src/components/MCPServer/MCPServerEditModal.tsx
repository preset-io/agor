import type {
  AgorClient,
  MCPScope,
  MCPServer,
  MCPTransport,
  UpdateMCPServerInput,
} from '@agor-live/client';
import { Alert, Button, Form, Modal, Space, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '@/utils/message';
import { MCPServerFormFields } from './MCPServerFormFields';
import {
  describeMissingForSave,
  firstFormErrorMessage,
  missingMCPFieldLabels,
  useFormRevision,
} from './mcp-form-requirements';
import { buildAuthFromValues, parseEnvJSON, parseHeadersJSON } from './mcp-oauth-utils';
import { useOAuthBrowserEventAttempt } from './useOAuthBrowserEventAttempt';

export interface MCPServerEditModalProps {
  /** The server being edited. Modal opens when this is non-null and `open` is true. */
  server: MCPServer | null;
  open: boolean;
  client: AgorClient | null;
  /** Authenticated identity that owns the form contents and selected server. */
  identityKey: string | null;
  /** Successful socket-auth generation used to scope compatibility events. */
  authGeneration: number;
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
  tools?: Array<{ name: string; description?: string }>;
  resources?: Array<{ name: string; uri: string; mimeType?: string }>;
  prompts?: Array<{ name: string; description?: string }>;
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
  identityKey,
  authGeneration,
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
  const [modal, modalContextHolder] = Modal.useModal();
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
  const [configConflict, setConfigConflict] = useState(false);
  const [reloadingLatest, setReloadingLatest] = useState(false);
  const [managedOAuthCompatibilityMode, setManagedOAuthCompatibilityMode] = useState<
    'strict' | 'marketplace' | undefined
  >();
  const [formRevision, bumpFormRevision] = useFormRevision();
  const operationGuard = useAuthorityOperationGuard(
    authorityKey && mutationAllowed ? [authorityKey, client, mutationAllowed] : null
  );
  const oauthBrowserEvents = useOAuthBrowserEventAttempt({
    client,
    currentUserId: identityKey,
    authGeneration,
    authorityGuard: operationGuard,
  });

  // Only ask the form once it is rendered and filled — an unmounted instance
  // warns, and a half-hydrated one would flash Save disabled.
  const missingRequiredFields =
    open && formHydrated
      ? missingMCPFieldLabels(form.getFieldsValue(true), { mode: 'edit', transport, authType })
      : [];
  const saveBlocked = !mutationAllowed || missingRequiredFields.length > 0;
  const mutationStateRef = useRef({ allowed: mutationAllowed, reason: mutationBlockedReason });
  const configVersionRef = useRef(1);
  mutationStateRef.current = { allowed: mutationAllowed, reason: mutationBlockedReason };

  // Hydrate the form when the modal opens or the user swaps to a different
  // server. Intentionally NOT keyed on `server` itself — that would clobber
  // in-progress edits whenever the parent's WebSocket sync re-emits the
  // record.
  // biome-ignore lint/correctness/useExhaustiveDependencies: see comment above
  useEffect(() => {
    if (!open || !server) return;

    setTestResult(null);
    setConfigConflict(false);
    configVersionRef.current = server.config_version ?? 1;
    setPreserveAbsentDcrMode(false);
    setPreserveAbsentCompatibilityMode(false);
    setPreserveAbsentGrantType(false);
    setManagedOAuthCompatibilityMode(undefined);
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
      setManagedOAuthCompatibilityMode(
        managedCompatibilityMode === 'strict' || managedCompatibilityMode === 'marketplace'
          ? managedCompatibilityMode
          : undefined
      );
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
    setConfigConflict(false);
    setReloadingLatest(false);
    setManagedOAuthCompatibilityMode(undefined);
    onClose();
  };

  const handleTestConnection = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
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
    let browserAttempt: Awaited<ReturnType<typeof oauthBrowserEvents.begin>> = null;
    try {
      await form.validateFields(['headers']);
    } catch {
      if (!operation.isCurrent()) return;
      showError('Please fix custom HTTP headers before testing');
      return;
    }
    if (!operation.isCurrent()) return;

    try {
      setTesting(true);
      setTestResult(null);
      browserAttempt = await oauthBrowserEvents.begin({
        operation: 'discover',
        mcpServerId: server.mcp_server_id,
      });
      if (!operation.isCurrent()) return;
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
        ...(browserAttempt ? { oauth_browser_event: browserAttempt.request } : {}),
      })) as {
        success: boolean;
        error?: string;
        capabilities?: { tools: number; resources: number; prompts: number };
        tools?: Array<{ name: string; description?: string }>;
        resources?: Array<{ name: string; uri: string; mimeType?: string }>;
        prompts?: Array<{ name: string; description?: string }>;
      };

      if (!operation.isCurrent()) return;

      if (data.success && data.capabilities) {
        const refreshed = await client.service('mcp-servers').get(server.mcp_server_id);
        if (!operation.isCurrent()) return;
        configVersionRef.current = refreshed.config_version ?? configVersionRef.current;
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
    } catch {
      if (!operation.isCurrent()) return;
      setTestResult({
        success: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        error: 'Connection test failed. Check the saved configuration and try again.',
      });
    } finally {
      browserAttempt?.cleanup();
      if (operation.isCurrent()) setTesting(false);
    }
  };

  const saveFormValues = async (
    operation: ReturnType<typeof operationGuard.begin>
  ): Promise<boolean> => {
    if (!server || !client || !operation.isCurrent()) return false;
    if (!mutationStateRef.current.allowed) {
      showError(mutationStateRef.current.reason);
      return false;
    }

    try {
      await form.validateFields();
      if (!operation.isCurrent()) return false;
      if (!mutationStateRef.current.allowed) {
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
        expected_config_version: configVersionRef.current,
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
        forPatch: true,
      });

      if (!operation.isCurrent()) return false;
      if (!mutationStateRef.current.allowed) {
        showError(mutationStateRef.current.reason);
        return false;
      }
      const updated = await client.service('mcp-servers').patch(server.mcp_server_id, updates);
      configVersionRef.current = updated.config_version ?? configVersionRef.current + 1;
      return operation.isCurrent();
    } catch (error) {
      if (!operation.isCurrent()) return false;
      const conflictData = (error as { code?: number; data?: { current_config_version?: number } })
        ?.data;
      if ((error as { code?: number })?.code === 409 || conflictData?.current_config_version) {
        setConfigConflict(true);
        showError(
          'This MCP server changed on another device. Reload the latest version before saving again.'
        );
        return false;
      }
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
    if (
      server?.enabled &&
      form.getFieldValue('enabled') === false &&
      (server.auth?.type === 'oauth' || authType === 'oauth')
    ) {
      const confirmed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const settle = (value: boolean) => {
          if (settled) return;
          settled = true;
          resolve(value);
        };
        modal.confirm({
          title: 'Disable this OAuth server?',
          content:
            'Disabling removes the saved OAuth connection from Agor. Re-enabling requires a new sign-in. Provider-side access may remain until you revoke it with the provider.',
          okText: 'Disable server',
          okButtonProps: { danger: true },
          cancelText: 'Keep enabled',
          onOk: () => settle(true),
          onCancel: () => settle(false),
          afterClose: () => settle(false),
        });
      });
      if (!confirmed) return;
    }
    const operation = operationGuard.begin();
    if (await saveFormValues(operation)) {
      if (!operation.isCurrent()) return;
      showSuccess('MCP server updated successfully');
      closeAndReset();
    }
  };

  const reloadLatest = async () => {
    if (!client || !server) return;
    setReloadingLatest(true);
    try {
      const latest = await client.service('mcp-servers').get(server.mcp_server_id);
      configVersionRef.current = latest.config_version ?? 1;
      const latestAuthType = latest.auth?.type || 'none';
      const latestManagedMode = latest.oauth_compatibility_policy?.managed_by_catalog
        ? latest.oauth_compatibility_policy.effective_mode
        : undefined;
      setManagedOAuthCompatibilityMode(
        latestManagedMode === 'strict' || latestManagedMode === 'marketplace'
          ? latestManagedMode
          : undefined
      );
      setPreserveAbsentDcrMode(latest.auth?.oauth_dcr_mode === undefined);
      setPreserveAbsentCompatibilityMode(latest.auth?.oauth_compatibility_mode === undefined);
      setPreserveAbsentGrantType(latest.auth?.oauth_grant_type === undefined);
      setTransport(latest.transport);
      setAuthType(latestAuthType);
      // Deliberately discard dirty fields. The conflict alert names this
      // behavior so an editor never mistakes Reload for a rebase operation.
      form.resetFields();
      form.setFieldsValue({
        name: latest.name,
        display_name: latest.display_name,
        description: latest.description,
        transport: latest.transport,
        command: latest.command,
        args: latest.args?.join(', '),
        url: latest.url,
        scope: latest.scope,
        enabled: latest.enabled,
        env: latest.env ? JSON.stringify(latest.env, null, 2) : undefined,
        headers: latest.headers ? JSON.stringify(latest.headers, null, 2) : undefined,
        auth_type: latestAuthType,
        auth_token: latest.auth?.token,
        jwt_api_url: latest.auth?.api_url,
        jwt_api_token: latest.auth?.api_token,
        jwt_api_secret: latest.auth?.api_secret,
        oauth_authorization_url: latest.auth?.oauth_authorization_url,
        oauth_token_url: latest.auth?.oauth_token_url,
        oauth_client_id: latest.auth?.oauth_client_id,
        oauth_client_secret: latest.auth?.oauth_client_secret,
        oauth_scope: latest.auth?.oauth_scope,
        oauth_grant_type: latest.auth?.oauth_grant_type || 'client_credentials',
        oauth_mode: latest.auth?.oauth_mode || 'per_user',
        oauth_compatibility_mode:
          latestManagedMode ?? latest.auth?.oauth_compatibility_mode ?? 'strict',
        oauth_dcr_mode: latest.auth?.oauth_dcr_mode || 'advertised',
      });
      setConfigConflict(false);
      bumpFormRevision();
    } catch (error) {
      showError(error instanceof Error ? error.message : 'Failed to reload the latest MCP server');
    } finally {
      setReloadingLatest(false);
    }
  };

  const prepareOAuthStart = async (): Promise<string | null> => {
    const operation = operationGuard.begin();
    if (!(await saveFormValues(operation)) || !operation.isCurrent()) return null;
    return server?.mcp_server_id ?? null;
  };

  return (
    <>
      {modalContextHolder}
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
        {configConflict && (
          <Alert
            type="warning"
            showIcon
            title="Newer MCP settings are available"
            description="Reloading fetches the current server and discards your unsaved edits."
            action={
              <Button loading={reloadingLatest} onClick={() => void reloadLatest()}>
                Reload latest
              </Button>
            }
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
            managedOAuthCompatibilityMode={managedOAuthCompatibilityMode}
          />
        </Form>
      </Modal>
    </>
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
