import type {
  AgorClient,
  CreateMCPServerInput,
  MCPScope,
  MCPServer,
  MCPTransport,
  UpdateMCPServerInput,
  UserID,
} from '@agor-live/client';
import { Alert, Button, Form, Modal, Space, Tooltip } from 'antd';
import { useEffect, useRef, useState } from 'react';
import {
  type AuthorityOperationGuard,
  useAuthorityOperationGuard,
} from '@/hooks/useAuthorityOperationGuard';
import {
  type ActionErrorCopy,
  describeActionError,
  isInFlightConnectionLossError,
} from '@/utils/connectionErrors';
import { useThemedMessage } from '@/utils/message';
import { ActionErrorNotice } from '../CompactNotice';
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
  /** The server being edited. `null` with `open` adds a new server instead. */
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
  /** Create mode only: whether Shared (workspace) ownership may be chosen. */
  allowSharedOwnership?: boolean;
  /** Create mode only: runs after Save with the server that was added. */
  onCreated?: (server: MCPServer) => void;
  /** Current server-side capability/connection decision from the owner. */
  mutationAllowed: boolean;
  mutationBlockedReason?: string;
  onClose: () => void;
  /** Runs after the portal has finished closing (for example, to restore focus). */
  afterClose?: () => void;
  /** Delegates focus restoration to an owner when the original trigger was unmounted. */
  focusTriggerAfterClose?: boolean;
}

const SHARED_NO_LONGER_ALLOWED =
  'You can no longer add shared servers, so choose Private or ask an administrator.';

/**
 * Self-contained "Edit MCP Server" modal, which also adds a server when opened
 * without one.
 *
 * Hydrates its own form from `server`, owns transport/authType/test state,
 * and persists via the `mcp-servers` Feathers service. A create persists once
 * (on Save, or before an OAuth start) and later saves patch that new row.
 * Used by `MyServersTab` (Marketplace) and `SessionMcpFooterControl` (admin
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
  allowSharedOwnership,
  onCreated,
  mutationAllowed,
  mutationBlockedReason = 'You can no longer change this MCP server.',
  onClose,
  afterClose,
  focusTriggerAfterClose,
}) => {
  const { showSuccess } = useThemedMessage();
  const [modal, modalContextHolder] = Modal.useModal();
  const [form] = Form.useForm();
  const [policySnapshot, setPolicySnapshot] = useState<MCPServer | null>(null);
  // Create mode: the row this form added, which later saves patch.
  const [createdServer, setCreatedServer] = useState<MCPServer | null>(null);
  // The form revision whose create lost its reply: Create stays off until the form changes.
  const [unconfirmedCreateRevision, setUnconfirmedCreateRevision] = useState<number | null>(null);
  // One save at a time, from Create/Save, Save & Test, and the OAuth start alike:
  // until a create replies there is no row to patch, so a second save would add another.
  const saveInFlightRef = useRef(false);
  const [saving, setSaving] = useState(false);
  const target = server ?? createdServer;
  const newestServer =
    policySnapshot?.mcp_server_id === target?.mcp_server_id &&
    (policySnapshot?.config_version ?? 0) > (target?.config_version ?? 1)
      ? policySnapshot
      : target;
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
  const [saveError, setSaveError] = useState<ActionErrorCopy | null>(null);
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
    contextKey: open ? (server?.mcp_server_id ?? 'create') : null,
  });
  const createUnconfirmed = !target && unconfirmedCreateRevision === formRevision;

  // Only ask the form once it is rendered and filled — an unmounted instance
  // warns, and a half-hydrated one would flash Save disabled.
  const missingRequiredFields =
    open && formHydrated
      ? missingMCPFieldLabels(form.getFieldsValue(true), {
          mode: target ? 'edit' : 'create',
          transport,
          authType,
        })
      : [];
  const saveBlocked =
    !mutationAllowed ||
    !authorityKey ||
    configConflict ||
    createUnconfirmed ||
    saving ||
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
    if (!open) return;
    if (!server) {
      // Create: start from the field defaults every time the modal opens.
      setPolicySnapshot(null);
      setCreatedServer(null);
      setUnconfirmedCreateRevision(null);
      setConfigConflict(false);
      setSaveError(null);
      configVersionRef.current = 1;
      setAuthType('none');
      setTransport(offeredTransports?.[0] ?? 'stdio');
      form.resetFields();
      setFormHydrated(true);
      bumpFormRevision();
      return;
    }

    setPolicySnapshot(null);
    setConfigConflict(false);
    setSaveError(null);
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
    setSaveError(null);
    setReloadScope(null);
    setManagedOAuthCompatibilityMode(undefined);
    setCreatedServer(null);
    setUnconfirmedCreateRevision(null);
    onClose();
  };

  // A saved ID is authoritative at the daemon. Save the draft first rather
  // than sending ignored inline credentials and claiming that they were tested.
  // An unsaved non-OAuth draft is tested inline so a test never adds a server.
  const handleTestConnection = () =>
    testConnection(async (operation) => {
      const values = form.getFieldsValue(true);
      if (!target && values.auth_type !== 'oauth') {
        setSaveError(null);
        try {
          await form.validateFields(['url', 'headers']);
        } catch (error) {
          if (operation.isCurrent()) setSaveError(describeFormError('test the connection', error));
          return null;
        }
        if (!values.url || values.transport === 'stdio') return null;
        return {
          url: values.url,
          transport: values.transport || 'http',
          auth: buildAuthFromValues(values),
          headers: parseHeadersJSON(values.headers),
        };
      }
      const saved = await saveFormValues(operation);
      return saved ? { mcp_server_id: server?.mcp_server_id ?? saved.mcp_server_id } : null;
    });

  const describeFormError = (action: string, error: unknown): ActionErrorCopy => {
    // Name the field: some sit in collapsed panels.
    const fieldError = firstFormErrorMessage(error);
    return fieldError
      ? { message: `Couldn't ${action}. ${fieldError}`, raw: null }
      : describeActionError(action, error, { idempotent: Boolean(target) });
  };

  const createServer = async (
    operation: ReturnType<typeof operationGuard.begin>,
    values: Record<string, unknown>
  ): Promise<MCPServer | null> => {
    if (!client || !identityKey || createUnconfirmed) return null;
    if (values.ownership === 'shared' && !allowSharedOwnership) {
      setSaveError({ message: SHARED_NO_LONGER_ALLOWED, raw: null });
      return null;
    }
    const data: CreateMCPServerInput = {
      owner_user_id: values.ownership === 'shared' ? null : (identityKey as UserID),
      name: values.name as string,
      display_name: values.display_name as string | undefined,
      description: values.description as string | undefined,
      transport: values.transport as MCPTransport,
      scope: (values.scope as MCPScope | undefined) ?? offeredScopes?.[0] ?? 'session',
      enabled: (values.enabled as boolean | undefined) ?? true,
    };
    if (values.transport === 'stdio') {
      data.command = values.command as string;
      data.args = (values.args as string)?.split(',').map((arg: string) => arg.trim()) || [];
    } else {
      data.url = values.url as string;
      const headers = parseHeadersJSON(values.headers);
      if (headers) data.headers = headers;
    }
    const auth = buildAuthFromValues(values);
    if (auth) data.auth = auth;
    const env = parseEnvJSON(values.env);
    if (env) data.env = env;

    if (!operation.isCurrent() || !mutationStateRef.current.allowed) return null;
    const created = await client.service('mcp-servers').create(data);
    if (!operation.isCurrent()) return null;
    configVersionRef.current = created.config_version ?? 1;
    setCreatedServer(created);
    return created;
  };

  const saveFormValues = async (
    operation: ReturnType<typeof operationGuard.begin>
  ): Promise<MCPServer | null> => {
    if (saveInFlightRef.current) return null;
    saveInFlightRef.current = true;
    setSaving(true);
    try {
      return await persistFormValues(operation);
    } finally {
      saveInFlightRef.current = false;
      setSaving(false);
    }
  };

  const persistFormValues = async (
    operation: ReturnType<typeof operationGuard.begin>
  ): Promise<MCPServer | null> => {
    // A lost edit permission shows as the form's policy notice and a disabled Save.
    if (!client || configConflict || !operation.isCurrent()) return null;
    if (!mutationStateRef.current.allowed) return null;
    setSaveError(null);

    try {
      await form.validateFields();
      if (!operation.isCurrent() || !mutationStateRef.current.allowed) return null;
      const values = form.getFieldsValue(true);
      if (!target) return await createServer(operation, values);

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

      if (!operation.isCurrent() || !mutationStateRef.current.allowed) return null;
      const updated = await client.service('mcp-servers').patch(target.mcp_server_id, updates);
      if (!operation.isCurrent()) return null;
      setPolicySnapshot(updated);
      configVersionRef.current = updated.config_version ?? configVersionRef.current + 1;
      return updated;
    } catch (error) {
      if (!operation.isCurrent()) return null;
      if (!target) {
        // A create retried after a lost reply could add the server twice.
        if (isInFlightConnectionLossError(error)) setUnconfirmedCreateRevision(formRevision);
        setSaveError(describeFormError('add the MCP server', error));
        return null;
      }
      const conflictData = (error as { code?: number; data?: { current_config_version?: number } })
        ?.data;
      if ((error as { code?: number })?.code === 409 || conflictData?.current_config_version) {
        setConfigConflict(true);
        return null;
      }
      // The patch is version-fenced, so a retry is safe.
      setSaveError(describeFormError('save the MCP server', error));
      return null;
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
    const saved = await saveFormValues(operation);
    if (saved) {
      if (!operation.isCurrent()) return;
      showSuccess(server ? 'MCP server saved.' : 'MCP server added.');
      if (!server) onCreated?.(saved);
      closeAndReset();
    }
  };

  const reloadLatest = async () => {
    const operation = operationGuard.begin();
    if (!client || !target || !operation.isCurrent()) return;
    setReloadScope(operationGuard);
    setSaveError(null);
    try {
      const latest = await client.service('mcp-servers').get(target.mcp_server_id);
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
      setSaveError(describeActionError('load the latest version', error, { idempotent: true }));
    } finally {
      if (operation.isCurrent()) setReloadScope(null);
    }
  };

  const prepareOAuthStart = async (): Promise<string | null> => {
    const operation = operationGuard.begin();
    const saved = await saveFormValues(operation);
    if (!saved || !operation.isCurrent()) return null;
    return server?.mcp_server_id ?? saved.mcp_server_id;
  };

  return (
    <>
      {modalContextHolder}
      <Modal
        title={server ? 'Edit MCP Server' : 'Add MCP Server'}
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
                    ? 'Load the latest version before you save again.'
                    : testing || reloadingLatest
                      ? 'Wait for the current connection operation to finish.'
                      : createUnconfirmed
                        ? 'Refresh to see if the server was added before you create it again.'
                        : !authorityKey
                          ? 'Reconnect before saving.'
                          : missingRequiredFields.length > 0
                            ? describeMissingForSave(missingRequiredFields)
                            : undefined
              }
            >
              <span>
                <Button type="primary" loading={saving} disabled={saveBlocked} onClick={handleSave}>
                  {target ? 'Save' : 'Create'}
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
            title="This MCP server was changed somewhere else. Load the latest version before you save again."
            description="Loading it discards your unsaved edits."
            action={
              <Button loading={reloadingLatest} onClick={() => void reloadLatest()}>
                Load latest
              </Button>
            }
            style={{ marginTop: 16 }}
          />
        )}
        {saveError && <ActionErrorNotice error={saveError} style={{ marginTop: 16 }} />}
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
            allowSharedOwnership={allowSharedOwnership}
            mode={target ? 'edit' : 'create'}
            savedOwnership={target?.owner_user_id ? 'private' : 'shared'}
            transport={transport}
            onTransportChange={setTransport}
            authType={authType}
            onAuthTypeChange={setAuthType}
            form={form}
            client={client}
            authorityKey={authorityKey}
            serverId={target?.mcp_server_id}
            onTestConnection={handleTestConnection}
            testing={testing}
            testResult={testResult}
            saving={saving}
            onPrepareOAuthStart={prepareOAuthStart}
            mutationAllowed={mutationAllowed && !configConflict && !reloadingLatest}
            mutationBlockedReason={
              configConflict
                ? 'Load the latest version before you try again.'
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
