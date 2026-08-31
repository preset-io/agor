import {
  type CreateMCPServerInput,
  hasMinimumRole,
  type MCPScope,
  type MCPServer,
  type MCPTransport,
  ROLES,
  shortId,
  type UpdateMCPServerInput,
  type User,
} from '@agor-live/client';
import {
  DeleteOutlined,
  EditOutlined,
  EyeOutlined,
  PlusOutlined,
  TeamOutlined,
  UserOutlined,
} from '@ant-design/icons';
import {
  Alert,
  Badge,
  Button,
  Descriptions,
  Form,
  Input,
  Popconfirm,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useConnectionState } from '@/contexts/ConnectionContext';
import { useAuthorityOperationGuard } from '@/hooks/useAuthorityOperationGuard';
import { useMcpMemberPolicy } from '@/hooks/useMcpMemberPolicy';
import { useAgorStore } from '@/store/agorStore';
import { selectUserAuthenticatedMcpServerIds } from '@/store/selectors';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { mcpServerNeedsAuth } from '@/utils/mcpAuth';
import { useThemedMessage } from '@/utils/message';
import { userSelectLabel } from '@/utils/selectSearch';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { HighlightMatch } from '../HighlightMatch';
import { MCPServerEditModal, MCPServerFormFields } from '../MCPServer';
import {
  describeMissingForSave,
  firstFormErrorMessage,
  missingMCPFieldLabels,
  useFormRevision,
} from '../MCPServer/mcp-form-requirements';
import { buildAuthFromValues, parseEnvJSON, parseHeadersJSON } from '../MCPServer/mcp-oauth-utils';
import {
  allowedMcpScopes,
  allowedMcpTransports,
  canAddMcpServer,
  canDeleteMcpServer,
  canEditMcpServer,
  explainAddRestriction,
  explainManageRestriction,
  type MCPServerCapabilityContext,
  policyPendingState,
} from '../MCPServer/memberPolicy';
import { useOAuthBrowserEventAttempt } from '../MCPServer/useOAuthBrowserEventAttempt';
import { AdaptiveSettingsModal } from './AdaptiveSettingsModal';
import { MCPMemberPolicySetting } from './MCPMemberPolicySetting';
import { ResponsiveSettingsHeader } from './ResponsiveSettingsHeader';
import { SettingsActionGroup } from './SettingsActionGroup';

interface MCPServersTableProps {
  mcpServerById: Map<string, MCPServer>;
  client: import('@agor-live/client').AgorClient | null;
  /** Resolves `owner_user_id` to a person; unowned servers name no user. */
  userById: Map<string, User>;
  currentUser?: User | null;
  onCreate?: (data: CreateMCPServerInput, shouldApply?: () => boolean) => void | Promise<void>;
  onDelete?: (serverId: string, shouldApply?: () => boolean) => void | Promise<void>;
}

/** How an unowned server reads: it is the workspace's, not nobody's. */
const SHARED_OWNER_LABEL = 'Shared with workspace';
const SHARED_OWNER_HINT = 'No owner — everyone in this workspace can use this server.';

const getServerHealth = (
  server: MCPServer,
  userAuthenticatedMcpServerIds: Set<string> = new Set()
) => {
  const toolCount = server.tools?.length || 0;
  const transport = server.transport || (server.url ? 'http' : 'stdio');

  // Ahead of every other reading, because it is the one that makes the row
  // unusable. Connecting a catalog entry writes the install before anybody
  // signs in, so an OAuth row that was never authenticated is enabled, owned,
  // and indistinguishable from a working server — this is the only thing in
  // the table that says the connect never finished.
  if (mcpServerNeedsAuth(server, userAuthenticatedMcpServerIds)) {
    return {
      status: 'warning' as const,
      text: 'Not signed in',
    };
  }

  if (transport === 'stdio') {
    return {
      status: 'default' as const,
      text: 'Local process',
    };
  }

  if (toolCount > 0) {
    return {
      status: 'success' as const,
      text: `${toolCount} tools`,
    };
  }

  return {
    status: 'default' as const,
    text: 'Not tested',
  };
};

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

const MCPServersTableForIdentity: React.FC<MCPServersTableProps> = ({
  mcpServerById,
  client,
  userById,
  currentUser,
  onCreate,
  onDelete,
}) => {
  const { showError } = useThemedMessage();
  // Same set the session panel and the picker read, so an install is
  // "unfinished" in exactly one sense across all three.
  const userAuthenticatedMcpServerIds = useAgorStore(selectUserAuthenticatedMcpServerIds);
  const { connected, connecting, authGeneration } = useConnectionState();
  const connectionReady = connected && !connecting;
  const memberPolicy = useMcpMemberPolicy(client, {
    connectionReady,
    currentUser,
    authGeneration,
  });
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  const { pending: policyPending, hint: policyPendingHint } = policyPendingState(memberPolicy);
  const durableAuthorityKey =
    client && connectionReady && !policyPending && currentUser?.user_id && currentUser.role
      ? `${currentUser.user_id}:${currentUser.role}:${authGeneration}`
      : null;
  const capability = useMemo<MCPServerCapabilityContext>(
    () => ({
      role: currentUser?.role,
      isAdmin,
      connectionReady,
      policy: memberPolicy.policy,
      userId: currentUser?.user_id,
      canConfigure: memberPolicy.canConfigure,
    }),
    [
      isAdmin,
      connectionReady,
      currentUser?.role,
      currentUser?.user_id,
      memberPolicy.policy,
      memberPolicy.canConfigure,
    ]
  );
  const canAdd = !policyPending && canAddMcpServer(capability);
  const addRestriction = policyPending ? policyPendingHint : explainAddRestriction(capability);
  const operationGuard = useAuthorityOperationGuard(
    durableAuthorityKey
      ? [durableAuthorityKey, client, memberPolicy.policy, memberPolicy.canConfigure]
      : null
  );
  const oauthBrowserEvents = useOAuthBrowserEventAttempt({
    client,
    currentUserId: currentUser?.user_id ?? null,
    authGeneration,
    authorityGuard: operationGuard,
  });
  const capabilityRef = useRef({ capability, policyPending, addRestriction });
  capabilityRef.current = { capability, policyPending, addRestriction };
  const addIsCurrentlyAllowed = () => {
    const current = capabilityRef.current;
    return (
      operationGuard.isCurrent() && !current.policyPending && canAddMcpServer(current.capability)
    );
  };
  // Which transports a user may configure turns on role alone, so this is known
  // before the policy fetch settles. The first entry is the default the create
  // form starts from — `MCP_TRANSPORTS` is ordered for that.
  const offeredTransports = useMemo(() => allowedMcpTransports({ isAdmin }), [isAdmin]);
  // Scope, unlike transport, is the policy's own question: `allow_private_only`
  // holds a member to servers they attach per session.
  const offeredScopes = useMemo(
    () => allowedMcpScopes({ isAdmin, policy: memberPolicy.policy }),
    [isAdmin, memberPolicy.policy]
  );
  const [createModalOpen, setCreateModalOpen] = useState(false);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [viewModalOpen, setViewModalOpen] = useState(false);
  const [editingServer, setEditingServer] = useState<MCPServer | null>(null);
  const [viewingServer, setViewingServer] = useState<MCPServer | null>(null);
  const [createForm] = Form.useForm();
  // Null means "whatever this user's first offered transport is" — held as a
  // derivation rather than a mount-time snapshot, so the field and the payload
  // cannot disagree if the signed-in user resolves after the first render.
  const [chosenTransport, setChosenTransport] = useState<MCPTransport | null>(null);
  const transport = chosenTransport ?? offeredTransports[0];
  const [authType, setAuthType] = useState<'none' | 'bearer' | 'jwt' | 'oauth'>('none');
  const [testing, setTesting] = useState(false);
  const [createdServerId, setCreatedServerId] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  const [formRevision, bumpFormRevision] = useFormRevision();
  // Only ask the form once it is rendered — an unmounted instance warns.
  const missingRequiredFields = createModalOpen
    ? missingMCPFieldLabels(createForm.getFieldsValue(true), {
        mode: 'create',
        transport,
        authType,
      })
    : [];
  // Once the row exists the button only dismisses the modal, so nothing about
  // the form should be able to trap the user behind it.
  const createBlocked = !createdServerId && (!canAdd || missingRequiredFields.length > 0);

  // Sync modal records when mcpServerById updates (real-time WebSocket
  // updates). An absent row is authoritative too: retaining the previous
  // object would expose caller A's private server after caller B's replacement
  // map has correctly omitted it.
  useEffect(() => {
    if (!editingServer) return;
    const updatedServer = mcpServerById.get(editingServer.mcp_server_id);
    if (!updatedServer) {
      setEditModalOpen(false);
      setEditingServer(null);
    } else if (updatedServer !== editingServer) {
      setEditingServer(updatedServer);
    }
  }, [mcpServerById, editingServer]);

  useEffect(() => {
    if (!viewingServer) return;
    const updatedServer = mcpServerById.get(viewingServer.mcp_server_id);
    if (!updatedServer) {
      setViewModalOpen(false);
      setViewingServer(null);
    } else if (updatedServer !== viewingServer) {
      setViewingServer(updatedServer);
    }
  }, [mcpServerById, viewingServer]);

  const buildCreateData = (values: Record<string, unknown>): CreateMCPServerInput => {
    const data: CreateMCPServerInput = {
      name: values.name as string,
      display_name: values.display_name as string | undefined,
      description: values.description as string | undefined,
      transport: values.transport as 'stdio' | 'http' | 'sse',
      scope: (values.scope as MCPScope | undefined) ?? offeredScopes[0],
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

    return data;
  };

  // Persist the current form before every OAuth start. The saved row is the
  // daemon's tenant-scoped authority for provider URL and client credentials.
  const prepareOAuthStartForCreate = async (): Promise<string | null> => {
    const operation = operationGuard.begin();
    if (!client || !operation.isCurrent()) return null;
    if (!addIsCurrentlyAllowed()) {
      showError(capabilityRef.current.addRestriction);
      return null;
    }
    try {
      await createForm.validateFields();
      if (!operation.isCurrent()) return null;
      if (!addIsCurrentlyAllowed()) {
        showError(capabilityRef.current.addRestriction);
        return null;
      }
      const data = buildCreateData(createForm.getFieldsValue(true));

      if (!createdServerId) {
        if (!operation.isCurrent() || !addIsCurrentlyAllowed()) return null;
        const result = await client.service('mcp-servers').create(data);
        if (!operation.isCurrent()) return null;
        const newServerId = (result as MCPServer).mcp_server_id || null;
        setCreatedServerId(newServerId);
        return newServerId;
      }

      const { name: _name, ...updates } = data;
      if (!operation.isCurrent() || !addIsCurrentlyAllowed()) return null;
      await client.service('mcp-servers').patch(createdServerId, updates as UpdateMCPServerInput);
      if (!operation.isCurrent()) return null;
      return createdServerId;
    } catch (error) {
      if (!operation.isCurrent()) return null;
      // Say which field. Swallowing a validation rejection here left the OAuth
      // button doing nothing at all, with nothing on screen to explain it.
      showError(
        firstFormErrorMessage(error) ??
          (error instanceof Error ? error.message : 'Failed to save MCP server')
      );
      return null;
    }
  };

  const resetCreateModal = () => {
    createForm.resetFields();
    setCreateModalOpen(false);
    setChosenTransport(null);
    setAuthType('none');
    setTestResult(null);
    setCreatedServerId(null);
  };

  const handleCreate = async () => {
    if (createdServerId) {
      resetCreateModal();
      return;
    }

    if (!addIsCurrentlyAllowed()) {
      showError(capabilityRef.current.addRestriction);
      return;
    }

    const operation = operationGuard.begin();
    try {
      await createForm.validateFields();
      if (!operation.isCurrent()) return;
      if (!addIsCurrentlyAllowed()) {
        showError(capabilityRef.current.addRestriction);
        return;
      }
      const data = buildCreateData(createForm.getFieldsValue(true));
      if (!operation.isCurrent()) return;
      await onCreate?.(data, operation.isCurrent);
      if (!operation.isCurrent()) return;
      resetCreateModal();
    } catch (error) {
      if (!operation.isCurrent()) return;
      console.error('Form validation failed:', error);
      showError(firstFormErrorMessage(error) || 'Please fill in required fields');
    }
  };

  // Test connection from create modal (always inline config, no persistence).
  const handleCreateTestConnection = async () => {
    const operation = operationGuard.begin();
    if (!operation.isCurrent()) return;
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
    try {
      await createForm.validateFields(['headers']);
    } catch {
      if (!operation.isCurrent()) return;
      showError('Please fix custom HTTP headers before testing');
      return;
    }
    if (!operation.isCurrent()) return;

    let browserAttempt: Awaited<ReturnType<typeof oauthBrowserEvents.begin>> = null;
    try {
      setTesting(true);
      setTestResult(null);
      browserAttempt = await oauthBrowserEvents.begin({ operation: 'discover' });
      if (!operation.isCurrent()) return;
      const data = (await client.service('mcp-servers/discover').create({
        url: values.url,
        transport: values.transport || 'http',
        auth: buildAuthFromValues(values),
        headers: parseHeadersJSON(values.headers),
        ...(browserAttempt ? { oauth_browser_event: browserAttempt.request } : {}),
      })) as {
        success: boolean;
        error?: string;
        capabilities?: { tools: number; resources: number; prompts: number };
        tools?: Array<{ name: string; description: string }>;
        resources?: Array<{ name: string; uri: string; mimeType?: string }>;
        prompts?: Array<{ name: string; description: string }>;
      };

      if (!operation.isCurrent()) return;

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
      if (!operation.isCurrent()) return;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      setTestResult({
        success: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        error: errorMessage,
      });
    } finally {
      browserAttempt?.cleanup();
      if (operation.isCurrent()) setTesting(false);
    }
  };

  const handleEdit = useCallback((server: MCPServer) => {
    setEditingServer(server);
    setEditModalOpen(true);
  }, []);

  const handleEditClose = () => {
    setEditModalOpen(false);
    setEditingServer(null);
  };

  const handleView = useCallback((server: MCPServer) => {
    setViewingServer(server);
    setViewModalOpen(true);
  }, []);

  const resetViewModal = () => {
    setViewModalOpen(false);
    setViewingServer(null);
  };

  const handleDelete = useCallback(
    (serverId: string) => {
      const operation = operationGuard.begin();
      if (!operation.isCurrent()) return;
      void onDelete?.(serverId, operation.isCurrent);
    },
    [onDelete, operationGuard]
  );

  // An editor must be able to show the scope a row already carries, including
  // one the policy would no longer let its owner pick; narrowing it stays
  // available, and restating it is not a change the daemon refuses.
  const editableScopes = useMemo(
    () =>
      editingServer && !offeredScopes.includes(editingServer.scope)
        ? [...offeredScopes, editingServer.scope]
        : offeredScopes,
    [offeredScopes, editingServer]
  );

  const describeOwner = useCallback(
    (server: MCPServer) => {
      if (!server.owner_user_id) {
        return { text: SHARED_OWNER_LABEL, hint: SHARED_OWNER_HINT, shared: true };
      }
      const owner = userById.get(server.owner_user_id);
      const isSelf = server.owner_user_id === currentUser?.user_id;
      const text = owner ? owner.name?.trim() || owner.email : shortId(server.owner_user_id);
      return {
        text: isSelf ? `${text} (you)` : text,
        hint: `Private to ${owner ? userSelectLabel(owner) : server.owner_user_id} — usable only in their own sessions.`,
        shared: false,
      };
    },
    [userById, currentUser?.user_id]
  );

  const columns = useMemo(
    () => [
      {
        title: 'Name',
        dataIndex: 'name',
        key: 'name',
        width: 180,
        render: (_: string, server: MCPServer) => (
          <div>
            <div>
              <HighlightMatch text={server.display_name || server.name} query={searchTerm} />
            </div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              <HighlightMatch text={server.name} query={searchTerm} />
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
          const health = getServerHealth(server, userAuthenticatedMcpServerIds);
          return <Badge status={health.status} text={health.text} />;
        },
      },
      {
        title: 'Owner',
        dataIndex: 'owner_user_id',
        key: 'owner',
        width: 170,
        render: (_: string | undefined, server: MCPServer) => {
          const owner = describeOwner(server);
          return (
            <Tooltip title={owner.hint}>
              <Tag
                icon={owner.shared ? <TeamOutlined /> : <UserOutlined />}
                color={owner.shared ? 'default' : 'geekblue'}
              >
                <HighlightMatch text={owner.text} query={searchTerm} />
              </Tag>
            </Tooltip>
          );
        },
      },
      {
        title: 'Source',
        dataIndex: 'source',
        key: 'source',
        width: 100,
        render: (source: string) => (
          <Typography.Text type="secondary">
            <HighlightMatch text={source} query={searchTerm} />
          </Typography.Text>
        ),
      },
      {
        title: 'Actions',
        key: 'actions',
        width: 96,
        render: (_: unknown, server: MCPServer) => {
          const editable = canEditMcpServer(server, capability);
          const deletable = canDeleteMcpServer(server, capability);
          const restriction = policyPending
            ? policyPendingHint
            : explainManageRestriction(capability);
          return (
            <SettingsActionGroup>
              <Button
                type="text"
                size="small"
                icon={<EyeOutlined />}
                onClick={() => handleView(server)}
                title="View details"
              />
              {editable ? (
                <Button
                  type="text"
                  size="small"
                  icon={<EditOutlined />}
                  onClick={() => handleEdit(server)}
                  title="Edit"
                />
              ) : (
                <Tooltip title={restriction}>
                  <span>
                    <Button
                      type="text"
                      size="small"
                      icon={<EditOutlined />}
                      aria-label="Edit"
                      disabled
                    />
                  </span>
                </Tooltip>
              )}
              {deletable ? (
                <Popconfirm
                  title="Delete MCP server?"
                  description={`Are you sure you want to delete "${server.display_name || server.name}"?`}
                  onConfirm={() => handleDelete(server.mcp_server_id)}
                  okText="Delete"
                  cancelText="Cancel"
                  okButtonProps={{ danger: true }}
                >
                  <Button
                    type="text"
                    size="small"
                    icon={<DeleteOutlined />}
                    danger
                    title="Delete"
                  />
                </Popconfirm>
              ) : (
                <Tooltip title={restriction}>
                  <span>
                    <Button
                      type="text"
                      size="small"
                      icon={<DeleteOutlined />}
                      aria-label="Delete"
                      danger
                      disabled
                    />
                  </span>
                </Tooltip>
              )}
            </SettingsActionGroup>
          );
        },
      },
    ],
    [
      capability,
      describeOwner,
      handleDelete,
      handleEdit,
      handleView,
      policyPending,
      policyPendingHint,
      searchTerm,
      userAuthenticatedMcpServerIds,
    ]
  );

  const servers = useMemo(() => {
    const sorted = mapToSortedArray(mcpServerById, (a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
    );
    return filterBySettingsSearch(sorted, searchTerm, [
      (server) => server.name,
      (server) => server.display_name,
      (server) => server.description,
      (server) => server.transport,
      (server) => server.scope,
      (server) => server.source,
      (server) => server.url,
      (server) => server.command,
      (server) => server.args,
      (server) => server.enabled,
      (server) => server.tools?.flatMap((tool) => [tool.name, tool.description]),
      (server) => describeOwner(server).text,
    ]);
  }, [mcpServerById, searchTerm, describeOwner]);

  const serversPane = (
    <>
      <ResponsiveSettingsHeader
        description="Configure Model Context Protocol servers for enhanced AI capabilities."
        actions={(compact) => (
          <Space wrap style={{ width: compact ? '100%' : undefined }}>
            <Input
              allowClear
              placeholder="Search name, owner, URL, command, tools, transport, or scope"
              value={searchTerm}
              onChange={(event) => setSearchTerm(event.target.value)}
              style={{ width: compact ? '100%' : 360, flex: compact ? '1 1 100%' : undefined }}
            />
            {canAdd ? (
              <Button
                type="primary"
                icon={<PlusOutlined />}
                onClick={() => setCreateModalOpen(true)}
              >
                New MCP Server
              </Button>
            ) : (
              <Tooltip
                title={policyPending ? policyPendingHint : explainAddRestriction(capability)}
              >
                <span>
                  <Button type="primary" icon={<PlusOutlined />} disabled>
                    New MCP Server
                  </Button>
                </span>
              </Tooltip>
            )}
          </Space>
        )}
      />

      <Table
        dataSource={servers}
        columns={columns}
        rowKey="mcp_server_id"
        pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        size="small"
        scroll={{ x: 1000 }}
      />

      {/* Create MCP Server Modal */}
      <AdaptiveSettingsModal
        title="Add MCP Server"
        open={createModalOpen}
        onCancel={resetCreateModal}
        width={600}
        destroyOnHidden
        footer={
          <Space>
            <Button onClick={resetCreateModal}>Cancel</Button>
            {/* A disabled button can't host a tooltip of its own — hence the span. */}
            <Tooltip
              title={
                !createdServerId && !canAdd
                  ? addRestriction
                  : createBlocked
                    ? describeMissingForSave(missingRequiredFields)
                    : undefined
              }
            >
              <span>
                <Button type="primary" disabled={createBlocked} onClick={handleCreate}>
                  {createdServerId ? 'Done' : 'Create'}
                </Button>
              </span>
            </Tooltip>
          </Space>
        }
      >
        {!canAdd && (
          <Alert
            type="warning"
            showIcon
            title="MCP server changes are unavailable"
            description={addRestriction}
            style={{ marginBottom: 16 }}
          />
        )}
        <Form
          form={createForm}
          layout="vertical"
          style={{ marginTop: 16 }}
          onValuesChange={bumpFormRevision}
        >
          <MCPServerFormFields
            mode="create"
            transport={transport}
            onTransportChange={setChosenTransport}
            offeredTransports={offeredTransports}
            offeredScopes={offeredScopes}
            authType={authType}
            onAuthTypeChange={setAuthType}
            form={createForm}
            client={client}
            authorityKey={durableAuthorityKey}
            serverId={createdServerId ?? undefined}
            onTestConnection={handleCreateTestConnection}
            testing={testing}
            testResult={testResult}
            onPrepareOAuthStart={prepareOAuthStartForCreate}
            mutationAllowed={canAdd}
            mutationBlockedReason={addRestriction}
            formRevision={formRevision}
          />
        </Form>
      </AdaptiveSettingsModal>

      {/* Edit MCP Server Modal — self-contained */}
      <MCPServerEditModal
        server={editingServer}
        open={editModalOpen}
        client={client}
        identityKey={currentUser?.user_id ?? null}
        authGeneration={authGeneration}
        authorityKey={durableAuthorityKey}
        offeredTransports={offeredTransports}
        offeredScopes={editableScopes}
        mutationAllowed={
          !!editingServer && !policyPending && canEditMcpServer(editingServer, capability)
        }
        mutationBlockedReason={
          policyPending ? policyPendingHint : explainManageRestriction(capability)
        }
        onClose={handleEditClose}
      />

      {/* View MCP Server Modal */}
      <AdaptiveSettingsModal
        title="MCP Server Details"
        open={viewModalOpen}
        onCancel={resetViewModal}
        footer={[
          <Button key="close" onClick={resetViewModal}>
            Close
          </Button>,
        ]}
        width={700}
      >
        {viewingServer && (
          <Descriptions bordered column={1} size="small" style={{ marginTop: 16 }}>
            <Descriptions.Item label="ID">
              {shortId(viewingServer.mcp_server_id as string)}
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
            <Descriptions.Item label="Owner">
              <Space orientation="vertical" size={0}>
                <span>{describeOwner(viewingServer).text}</span>
                <Typography.Text type="secondary">
                  {describeOwner(viewingServer).hint}
                </Typography.Text>
              </Space>
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

            {viewingServer.headers && Object.keys(viewingServer.headers).length > 0 && (
              <Descriptions.Item label="Custom HTTP Headers">
                <pre style={{ margin: 0, fontSize: 12 }}>
                  {JSON.stringify(viewingServer.headers, null, 2)}
                </pre>
              </Descriptions.Item>
            )}

            {/*
              Header and auth values arrive redacted from the API; environment
              values do not, and a server's env routinely holds its credentials.
              Printing them only for the people who may change the server is a
              narrowing, not a boundary — the redaction belongs beside the one
              the other secret fields already get.
            */}
            {canEditMcpServer(viewingServer, capability) &&
              viewingServer.env &&
              Object.keys(viewingServer.env).length > 0 && (
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
      </AdaptiveSettingsModal>
    </>
  );

  return (
    <Tabs
      // The servers are what the tab is opened for; the policy that governs them
      // is a pane away rather than a band above them.
      defaultActiveKey="servers"
      items={[
        {
          key: 'servers',
          label: 'Servers',
          children: serversPane,
        },
        {
          key: 'policy',
          // Ungated on purpose: this is the answer to "why is New MCP Server
          // greyed out for me?", and the member who is refused is the reader who
          // needs it.
          label: 'Member policy',
          children: (
            <MCPMemberPolicySetting
              policy={memberPolicy.policy}
              loading={memberPolicy.loading}
              saving={memberPolicy.saving}
              error={memberPolicy.error}
              editable={capability.isAdmin}
              onChange={memberPolicy.save}
            />
          ),
        },
      ]}
    />
  );
};

/**
 * Ant Form instances and modal state are caller-private: they can contain raw
 * bearer/JWT/OAuth credentials and unredacted environment values. Key the
 * complete state owner by authenticated identity so React destroys caller A's
 * form and overlays in the same reconciliation that renders caller B. Socket
 * reconnects and token rotations for the same user keep the key and therefore
 * preserve ordinary in-progress work.
 */
export const MCPServersTable: React.FC<MCPServersTableProps> = (props) => (
  <MCPServersTableForIdentity
    key={props.currentUser?.user_id ?? '__no-authenticated-user__'}
    {...props}
  />
);
