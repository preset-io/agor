import {
  type CreateMCPServerInput,
  hasMinimumRole,
  type MCPServer,
  type MCPTransport,
  ROLES,
  shortId,
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
  Badge,
  Button,
  Descriptions,
  Form,
  Input,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from 'antd';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useMcpMemberPolicy } from '@/hooks/useMcpMemberPolicy';
import { mapToSortedArray } from '@/utils/mapHelpers';
import { useThemedMessage } from '@/utils/message';
import { userSelectLabel } from '@/utils/selectSearch';
import { filterBySettingsSearch } from '@/utils/settingsSearch';
import { HighlightMatch } from '../HighlightMatch';
import { MCPServerEditModal, MCPServerFormFields } from '../MCPServer';
import { buildAuthFromValues, parseEnvJSON, parseHeadersJSON } from '../MCPServer/mcp-oauth-utils';
import {
  allowedMcpTransports,
  canAddMcpServer,
  canDeleteMcpServer,
  canEditMcpServer,
  explainAddRestriction,
  explainManageRestriction,
  type MCPServerCapabilityContext,
} from '../MCPServer/memberPolicy';
import { MCPMemberPolicyCard } from './MCPMemberPolicyCard';
import { SettingsActionGroup } from './SettingsActionGroup';

interface MCPServersTableProps {
  mcpServerById: Map<string, MCPServer>;
  client: import('@agor-live/client').AgorClient | null;
  /** Resolves `owner_user_id` to a person; unowned servers name no user. */
  userById: Map<string, User>;
  currentUser?: User | null;
  onCreate?: (data: CreateMCPServerInput) => void;
  onDelete?: (serverId: string) => void;
}

/** How an unowned server reads: it is the workspace's, not nobody's. */
const SHARED_OWNER_LABEL = 'Shared with workspace';
const SHARED_OWNER_HINT = 'No owner — everyone in this workspace can use this server.';

const POLICY_LOADING_HINT = "Checking what this workspace's MCP policy allows…";
const POLICY_UNREADABLE_HINT =
  "This workspace's MCP policy could not be read, so nothing is offered here.";

const getServerHealth = (server: MCPServer) => {
  const toolCount = server.tools?.length || 0;
  const transport = server.transport || (server.url ? 'http' : 'stdio');

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

export const MCPServersTable: React.FC<MCPServersTableProps> = ({
  mcpServerById,
  client,
  userById,
  currentUser,
  onCreate,
  onDelete,
}) => {
  const { showError } = useThemedMessage();
  const memberPolicy = useMcpMemberPolicy(client);
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);
  // Which transports a user may configure turns on role alone, so this is known
  // before the policy fetch settles. The first entry is the default the create
  // form starts from — `MCP_TRANSPORTS` is ordered for that.
  const offeredTransports = useMemo(() => allowedMcpTransports({ isAdmin }), [isAdmin]);
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
  const [alreadyCreatedInOAuthFlow, setAlreadyCreatedInOAuthFlow] = useState(false);
  const [testResult, setTestResult] = useState<TestResult | null>(null);
  const [searchTerm, setSearchTerm] = useState('');

  // Sync editing server when mcpServerById updates (real-time WebSocket updates).
  // Also keeps the open edit modal in sync if the underlying record changes.
  useEffect(() => {
    if (editingServer && mcpServerById.has(editingServer.mcp_server_id)) {
      const updatedServer = mcpServerById.get(editingServer.mcp_server_id);
      if (updatedServer && updatedServer !== editingServer) {
        setEditingServer(updatedServer);
      }
    }
  }, [mcpServerById, editingServer]);

  const buildCreateData = (values: Record<string, unknown>): CreateMCPServerInput => {
    const data: CreateMCPServerInput = {
      name: values.name as string,
      display_name: values.display_name as string | undefined,
      description: values.description as string | undefined,
      transport: values.transport as 'stdio' | 'http' | 'sse',
      scope: (values.scope as 'global' | 'session' | undefined) || 'global',
      enabled: (values.enabled as boolean | undefined) ?? true,
      source: 'user',
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

  // Save server first for OAuth flow in create mode (returns new server ID)
  const handleSaveFirstForCreate = async (): Promise<string | null> => {
    if (!client) return null;
    try {
      await createForm.validateFields();
      const data = buildCreateData(createForm.getFieldsValue(true));
      const result = await client.service('mcp-servers').create(data);
      setAlreadyCreatedInOAuthFlow(true);
      return (result as MCPServer).mcp_server_id || null;
    } catch {
      return null;
    }
  };

  const resetCreateModal = () => {
    createForm.resetFields();
    setCreateModalOpen(false);
    setChosenTransport(null);
    setAuthType('none');
    setTestResult(null);
    setAlreadyCreatedInOAuthFlow(false);
  };

  const handleCreate = () => {
    if (alreadyCreatedInOAuthFlow) {
      resetCreateModal();
      return;
    }

    createForm
      .validateFields()
      .then(() => {
        const data = buildCreateData(createForm.getFieldsValue(true));
        onCreate?.(data);
        resetCreateModal();
      })
      .catch((error) => {
        console.error('Form validation failed:', error);
        if (error.errorFields && error.errorFields.length > 0) {
          const firstError = error.errorFields[0];
          showError(firstError.errors[0] || 'Please fill in required fields');
        }
      });
  };

  // Test connection from create modal (always inline config, no persistence).
  const handleCreateTestConnection = async () => {
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
      showError('Please fix custom HTTP headers before testing');
      return;
    }

    setTesting(true);
    setTestResult(null);

    try {
      const data = (await client.service('mcp-servers/discover').create({
        url: values.url,
        transport: values.transport || 'http',
        auth: buildAuthFromValues(values),
        headers: parseHeadersJSON(values.headers),
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

  const handleDelete = useCallback(
    (serverId: string) => {
      onDelete?.(serverId);
    },
    [onDelete]
  );

  // Until the policy is known the table offers nothing and says only that. The
  // restrictive value it falls back to — while loading, or when the read failed
  // — is a safe assumption to act on, not a fact about this workspace to quote
  // back as the reason.
  const policyPending = memberPolicy.loading || memberPolicy.error !== null;
  const policyPendingHint = memberPolicy.error ? POLICY_UNREADABLE_HINT : POLICY_LOADING_HINT;

  const capability = useMemo<MCPServerCapabilityContext>(
    () => ({ isAdmin, policy: memberPolicy.policy, userId: currentUser?.user_id }),
    [isAdmin, currentUser?.user_id, memberPolicy.policy]
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
          const health = getServerHealth(server);
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
            : explainManageRestriction(capability.policy);
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

  const canAdd = !policyPending && canAddMcpServer(capability);

  return (
    <div>
      <MCPMemberPolicyCard
        policy={memberPolicy.policy}
        loading={memberPolicy.loading}
        saving={memberPolicy.saving}
        error={memberPolicy.error}
        editable={capability.isAdmin}
        onChange={memberPolicy.save}
      />

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
        <Space>
          <Input
            allowClear
            placeholder="Search name, owner, URL, command, tools, transport, or scope"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            style={{ width: 360 }}
          />
          {canAdd ? (
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateModalOpen(true)}>
              New MCP Server
            </Button>
          ) : (
            <Tooltip
              title={policyPending ? policyPendingHint : explainAddRestriction(capability.policy)}
            >
              <span>
                <Button type="primary" icon={<PlusOutlined />} disabled>
                  New MCP Server
                </Button>
              </span>
            </Tooltip>
          )}
        </Space>
      </div>

      <Table
        dataSource={servers}
        columns={columns}
        rowKey="mcp_server_id"
        pagination={{ defaultPageSize: 10, showSizeChanger: true }}
        size="small"
      />

      {/* Create MCP Server Modal */}
      <Modal
        title="Add MCP Server"
        open={createModalOpen}
        onOk={handleCreate}
        onCancel={resetCreateModal}
        okText={alreadyCreatedInOAuthFlow ? 'Done' : 'Create'}
        width={600}
      >
        <Form form={createForm} layout="vertical" style={{ marginTop: 16 }}>
          <MCPServerFormFields
            mode="create"
            transport={transport}
            onTransportChange={setChosenTransport}
            offeredTransports={offeredTransports}
            authType={authType}
            onAuthTypeChange={setAuthType}
            form={createForm}
            client={client}
            onTestConnection={handleCreateTestConnection}
            testing={testing}
            testResult={testResult}
            onSaveFirst={handleSaveFirstForCreate}
          />
        </Form>
      </Modal>

      {/* Edit MCP Server Modal — self-contained */}
      <MCPServerEditModal
        server={editingServer}
        open={editModalOpen}
        client={client}
        offeredTransports={offeredTransports}
        onClose={handleEditClose}
      />

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
      </Modal>
    </div>
  );
};
