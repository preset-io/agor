import type {
  AgorClient,
  MCPScope,
  MCPServer,
  MCPTransport,
  UpdateMCPServerInput,
} from '@agor-live/client';
import { Alert, Button, Form, Modal, Space, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  type AuthorityOperationGuard,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';
import { useThemedMessage } from '@/utils/message';
import { MCPOAuthPolicySummary } from './MCPOAuthPolicySummary';
import { MCPServerFormFields } from './MCPServerFormFields';
import {
  describeMissingForSave,
  firstFormErrorMessage,
  missingMCPFieldLabels,
  useFormRevision,
} from './mcp-form-requirements';
import { buildAuthFromValues, parseEnvJSON, parseHeadersJSON } from './mcp-oauth-utils';
import { useMCPServerDiscovery } from './useMCPServerDiscovery';
import { useSavedMCPOAuthPolicy } from './useSavedMCPOAuthPolicy';

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
  const [policySnapshot, setPolicySnapshot] = useState<MCPServer | null>(null);
  const newestServer =
    policySnapshot?.mcp_server_id === server?.mcp_server_id &&
    (policySnapshot?.config_version ?? 0) > (server?.config_version ?? 1)
      ? policySnapshot
      : server;
  const { policyServer, policyUnavailable, retryPolicy } = useSavedMCPOAuthPolicy({
    server: newestServer,
    client,
    authorityKey,
    open,
  });
  const [transport, setTransport] = useState<MCPTransport>('stdio');
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt' | 'oauth'>('none');
  const [preserveAbsentDcrMode, setPreserveAbsentDcrMode] = useState(false);
  const [preserveAbsentCompatibilityMode, setPreserveAbsentCompatibilityMode] = useState(false);
  const [preserveAbsentGrantType, setPreserveAbsentGrantType] = useState(false);
  // The form is filled in an effect, so its fields read blank on the first
  // render. Gating on this keeps Save from flashing disabled while the modal
  // animates in.
  const [formHydrated, setFormHydrated] = useState(false);
  const [configConflict, setConfigConflict] = useState(false);
  const [reloadScope, setReloadScope] = useState<AuthorityOperationGuard | null>(null);
  const [managedOAuthCompatibilityMode, setManagedOAuthCompatibilityMode] = useState<
    'strict' | 'marketplace' | undefined
  >();
  const [formRevision, bumpFormRevision] = useFormRevision();
  const operationGuard = useAuthorityOperationGuard(
    authorityKey && mutationAllowed
      ? [authorityKey, client, mutationAllowed, open, server?.mcp_server_id]
      : null
  );
  const reloadingLatest = reloadScope === operationGuard;
  const { testing, testResult, testConnection } = useMCPServerDiscovery({
    client,
    authorityKey: mutationAllowed ? authorityKey : null,
    currentUserId: identityKey,
    authGeneration,
    formRevision,
    contextKey: open ? (server?.mcp_server_id ?? null) : null,
  });

  // Only ask the form once it is rendered and filled — an unmounted instance
  // warns, and a half-hydrated one would flash Save disabled.
  const missingRequiredFields =
    open && formHydrated
      ? missingMCPFieldLabels(form.getFieldsValue(true), { mode: 'edit', transport, authType })
      : [];
  const saveBlocked =
    !mutationAllowed ||
    !authorityKey ||
    configConflict ||
    testing ||
    reloadingLatest ||
    missingRequiredFields.length > 0;
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

    setPolicySnapshot(null);
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
  }, [open, server?.mcp_server_id, form]);

  const closeAndReset = () => {
    form.resetFields();
    setTransport('stdio');
    setAuthType('none');
    setPreserveAbsentDcrMode(false);
    setPreserveAbsentCompatibilityMode(false);
    setPreserveAbsentGrantType(false);
    setFormHydrated(false);
    setConfigConflict(false);
    setReloadScope(null);
    setManagedOAuthCompatibilityMode(undefined);
    onClose();
  };

  // A saved ID is authoritative at the daemon. Save the draft first rather
  // than sending ignored inline credentials and claiming that they were tested.
  const handleTestConnection = () =>
    testConnection(async (operation) => {
      if (!server || !(await saveFormValues(operation))) return null;
      return { mcp_server_id: server.mcp_server_id };
    });

  const saveFormValues = async (
    operation: ReturnType<typeof operationGuard.begin>
  ): Promise<boolean> => {
    if (!server || !client || configConflict || !operation.isCurrent()) return false;
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
        updates.headers = parseHeadersJSON(values.headers) ?? {};
      }

      updates.env = parseEnvJSON(values.env) ?? {};

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
      if (!operation.isCurrent()) return false;
      setPolicySnapshot(updated);
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
    const operation = operationGuard.begin();
    if (!client || !server || !operation.isCurrent()) return;
    setReloadScope(operationGuard);
    try {
      const latest = await client.service('mcp-servers').get(server.mcp_server_id);
      if (!operation.isCurrent()) return;
      setPolicySnapshot(latest);
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
      if (!operation.isCurrent()) return;
      showError(error instanceof Error ? error.message : 'Failed to reload the latest MCP server');
    } finally {
      if (operation.isCurrent()) setReloadScope(null);
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
                  : configConflict
                    ? 'Reload the latest settings before saving again.'
                    : testing || reloadingLatest
                      ? 'Wait for the current connection operation to finish.'
                      : !authorityKey
                        ? 'Reconnect before saving.'
                        : missingRequiredFields.length > 0
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
        {policyServer?.auth?.type === 'oauth' && policyServer.oauth_compatibility_policy && (
          <MCPOAuthPolicySummary
            policy={policyServer.oauth_compatibility_policy}
            label="Saved OAuth policy"
          />
        )}
        {policyServer?.auth?.type === 'oauth' && !policyServer.oauth_compatibility_policy && (
          <Alert
            type={policyUnavailable ? 'warning' : 'info'}
            title={
              policyUnavailable
                ? 'Saved OAuth policy is unavailable'
                : 'Loading saved OAuth policy…'
            }
            action={policyUnavailable && <Button onClick={retryPolicy}>Retry policy read</Button>}
          />
        )}
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
            mutationAllowed={mutationAllowed && !configConflict && !reloadingLatest}
            mutationBlockedReason={
              configConflict
                ? 'Reload the latest settings before trying again.'
                : reloadingLatest
                  ? 'Wait for the latest settings to load.'
                  : mutationBlockedReason
            }
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
 * state owner when the authenticated identity or selected server changes so another same-role
 * caller cannot inherit a selected row or any registered Ant Form value.
 * `authorityKey` remains a finer mutation gate; it intentionally does not key
 * this owner, preserving same-user reconnect and token-refresh edits.
 */
export const MCPServerEditModal: React.FC<MCPServerEditModalProps> = (props) => (
  <MCPServerEditModalForIdentity
    key={`${props.identityKey ?? '__no-authenticated-user__'}:${props.server?.mcp_server_id ?? ''}`}
    {...props}
  />
);
