import type {
  AgorClient,
  Artifact,
  Board,
  BoardEntityObject,
  Branch,
  CardType,
  CardWithType,
  CreateLocalRepoRequest,
  CreateMCPServerInput,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannel,
  MCPServer,
  Repo,
  Session,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import {
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  CloseOutlined,
  CreditCardOutlined,
  ExperimentOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  RobotOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Layout, Menu, Modal, theme } from 'antd';
import { useMemo, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { useServiceEnabled } from '../../hooks/useServicesConfig';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../hooks/useSettingsRoute';
import { BranchModal } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
import { AboutTab } from './AboutTab';
import { AgenticToolsSection } from './AgenticToolsSection';
import { ArtifactsTable } from './ArtifactsTable';
import { AssistantsTable } from './AssistantsTable';
import { BoardsTable } from './BoardsTable';
import { BranchesTable } from './BranchesTable';
import { CardsTable } from './CardsTable';
import { GatewayChannelsTable } from './GatewayChannelsTable';
import { GroupsTable } from './GroupsTable';
import { MCPServersTable } from './MCPServersTable';
import { ReposTable } from './ReposTable';
import { UsersTable } from './UsersTable';

const { Sider, Content } = Layout;

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null; // Still needed for BranchModal
  currentUser?: User | null; // Current logged-in user
  boardById: Map<string, Board>;
  boardObjects: BoardEntityObject[];
  repoById: Map<string, Repo>;
  branchById: Map<string, Branch>;
  sessionsByBranch: Map<string, Session[]>; // O(1) branch filtering
  userById: Map<string, User>;
  mcpServerById: Map<string, MCPServer>;
  cardById?: Map<string, CardWithType>;
  cardTypeById?: Map<string, CardType>;
  activeTab?: string; // Control which tab is shown when modal opens
  onTabChange?: (tabKey: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onArchiveBoard?: (boardId: string) => void;
  onUnarchiveBoard?: (boardId: string) => void;
  onCreateRepo?: (data: CreateRepoRequest) => void | Promise<void>;
  onCreateLocalRepo?: (data: CreateLocalRepoRequest) => void | Promise<void>;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string, cleanup: boolean) => void;
  onArchiveOrDeleteBranch?: (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onUnarchiveBranch?: (branchId: string, options?: { boardId?: string }) => void;
  onUpdateBranch?: (branchId: string, updates: BranchUpdate) => void;
  onCreateBranch?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
      storage_mode?: 'worktree' | 'clone';
      clone_depth?: number;
    }
  ) => Promise<Branch | null>;
  onStartEnvironment?: (branchId: string) => void;
  onStopEnvironment?: (branchId: string) => void;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: CreateMCPServerInput) => void;
  onDeleteMCPServer?: (serverId: string) => void;
  gatewayChannelById?: Map<string, GatewayChannel>;
  onCreateGatewayChannel?: (data: Partial<GatewayChannel>) => void;
  onUpdateGatewayChannel?: (channelId: string, updates: Partial<GatewayChannel>) => void;
  onDeleteGatewayChannel?: (channelId: string) => void;
  artifactById?: Map<string, Artifact>;
  onUpdateArtifact?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDeleteArtifact?: (artifactId: string) => void;
  onCreateAssistant?: () => void;
  branchStorageConfig?: BranchStorageConfig;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  client,
  currentUser,
  boardById,
  boardObjects,
  repoById,
  branchById,
  sessionsByBranch,
  userById,
  mcpServerById,
  cardById = new Map(),
  cardTypeById = new Map(),
  activeTab = 'boards',
  onTabChange,
  onCreateBoard,
  onUpdateBoard,
  onDeleteBoard,
  onArchiveBoard,
  onUnarchiveBoard,
  onCreateRepo,
  onCreateLocalRepo,
  onUpdateRepo,
  onDeleteRepo,
  onArchiveOrDeleteBranch,
  onUnarchiveBranch,
  onUpdateBranch,
  onCreateBranch,
  onStartEnvironment,
  onStopEnvironment,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onDeleteMCPServer,
  gatewayChannelById = new Map(),
  onCreateGatewayChannel,
  onUpdateGatewayChannel,
  onDeleteGatewayChannel,
  artifactById = new Map(),
  onUpdateArtifact,
  onDeleteArtifact,
  onCreateAssistant,
  branchStorageConfig,
}) => {
  const [selectedBranch, setSelectedBranch] = useState<Branch | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [branchSessions, setBranchSessions] = useState<Session[]>([]);
  const [branchModalOpen, setBranchModalOpen] = useState(false);

  const handleBranchRowClick = (branch: Branch) => {
    // Snapshot the data when opening modal
    setSelectedBranch(branch);
    setSelectedRepo(repoById.get(branch.repo_id) || null);
    setBranchSessions(sessionsByBranch.get(branch.branch_id) || []);
    setBranchModalOpen(true);
  };

  const handleBranchModalClose = () => {
    setBranchModalOpen(false);
    // Clear after modal closes
    setSelectedBranch(null);
    setSelectedRepo(null);
    setBranchSessions([]);
  };

  // Wrapper to close modal after archive/delete
  const handleArchiveOrDeleteBranchWithClose = async (
    branchId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => {
    await onArchiveOrDeleteBranch?.(branchId, options);
    handleBranchModalClose();
  };

  const { token } = theme.useToken();
  const settingsSectionKeys = useMemo(() => new Set<string>(SETTINGS_SECTIONS), []);

  // Service tier gates — hide tabs for disabled services
  const gatewayEnabled = useServiceEnabled('gateway');
  const mcpEnabled = useServiceEnabled('mcp_servers');
  const artifactsEnabled = useServiceEnabled('artifacts');
  const cardsEnabled = useServiceEnabled('cards');

  // Role gate — MCP Servers and Gateway Channels are global admin-managed
  // configuration (credentials, webhook URLs, env vars). The daemon enforces
  // ADMIN role on writes for both services (see register-hooks.ts); hiding
  // the menu entries here avoids showing members a tab where every action
  // would 403.
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  // Menu items for left sidebar navigation
  const menuItems: MenuProps['items'] = useMemo(
    () => [
      {
        key: 'workspace',
        label: 'Workspace',
        type: 'group' as const,
        children: [
          {
            key: 'boards',
            label: 'Boards',
            icon: <AppstoreOutlined />,
          },
          {
            key: 'repos',
            label: 'Repositories',
            icon: <FolderOutlined />,
          },
          {
            key: 'branches',
            label: 'Branches',
            icon: <BranchesOutlined />,
          },
          {
            key: 'assistants',
            label: 'Assistants',
            icon: <RobotOutlined />,
          },
          ...(cardsEnabled
            ? [
                {
                  key: 'cards',
                  label: (
                    <span>
                      Cards{' '}
                      <span
                        style={{
                          fontSize: 10,
                          fontWeight: 600,
                          padding: '0 4px',
                          borderRadius: 3,
                          background: token.colorWarningBg,
                          color: token.colorWarningText,
                          border: `1px solid ${token.colorWarningBorder}`,
                          marginLeft: 4,
                        }}
                      >
                        Beta
                      </span>
                    </span>
                  ),
                  icon: <CreditCardOutlined />,
                },
              ]
            : []),
          ...(artifactsEnabled
            ? [
                {
                  key: 'artifacts',
                  label: 'Artifacts',
                  icon: <ExperimentOutlined />,
                },
              ]
            : []),
        ],
      },
      {
        key: 'integrations',
        label: 'Integrations',
        type: 'group' as const,
        children: [
          {
            key: 'agentic-tools',
            label: 'Agentic Tools',
            icon: <ThunderboltOutlined />,
          },
          ...(mcpEnabled && isAdmin
            ? [
                {
                  key: 'mcp',
                  label: 'MCP Servers',
                  icon: <ApiOutlined />,
                },
              ]
            : []),
          ...(gatewayEnabled && isAdmin
            ? [
                {
                  key: 'gateway',
                  label: 'Gateway Channels',
                  icon: <MessageOutlined />,
                },
              ]
            : []),
        ],
      },
      {
        key: 'admin',
        label: 'Admin',
        type: 'group' as const,
        children: [
          ...(isAdmin
            ? [
                {
                  key: 'groups',
                  label: 'Groups',
                  icon: <TeamOutlined />,
                },
              ]
            : []),
          {
            key: 'users',
            label: 'Users',
            icon: <TeamOutlined />,
          },
        ],
      },
      {
        key: 'system',
        label: 'System',
        type: 'group' as const,
        children: [
          {
            key: 'about',
            label: 'About',
            icon: <InfoCircleOutlined />,
          },
        ],
      },
    ],
    [gatewayEnabled, mcpEnabled, artifactsEnabled, cardsEnabled, isAdmin, token]
  );

  // Render content based on active section
  const renderContent = () => {
    switch (activeTab) {
      case 'boards':
        return (
          <BoardsTable
            client={client}
            boardById={boardById}
            sessionsByBranch={sessionsByBranch}
            branchById={branchById}
            onCreate={onCreateBoard}
            onUpdate={onUpdateBoard}
            onDelete={onDeleteBoard}
            onArchive={onArchiveBoard}
            onUnarchive={onUnarchiveBoard}
          />
        );
      case 'repos':
        return (
          <ReposTable
            repoById={repoById}
            onCreate={onCreateRepo}
            onCreateLocal={onCreateLocalRepo}
            onUpdate={onUpdateRepo}
            onDelete={onDeleteRepo}
          />
        );
      case 'branches':
        return (
          <BranchesTable
            client={client}
            branchById={branchById}
            repoById={repoById}
            boardById={boardById}
            sessionsByBranch={sessionsByBranch}
            onArchiveOrDelete={onArchiveOrDeleteBranch}
            onUnarchive={onUnarchiveBranch}
            onCreate={onCreateBranch}
            onRowClick={handleBranchRowClick}
            onStartEnvironment={onStartEnvironment}
            onStopEnvironment={onStopEnvironment}
            onClose={onClose}
            branchStorageConfig={branchStorageConfig}
          />
        );
      case 'assistants':
        return (
          <AssistantsTable
            branchById={branchById}
            repoById={repoById}
            boardById={boardById}
            sessionsByBranch={sessionsByBranch}
            userById={userById}
            onArchiveOrDelete={onArchiveOrDeleteBranch}
            onRowClick={handleBranchRowClick}
            onCreateAssistant={onCreateAssistant}
            onClose={onClose}
          />
        );
      case 'cards':
        return (
          <CardsTable
            client={client}
            cardById={cardById}
            cardTypeById={cardTypeById}
            boardById={boardById}
            boardObjects={boardObjects}
          />
        );
      case 'artifacts':
        return (
          <ArtifactsTable
            artifactById={artifactById}
            branchById={branchById}
            boardById={boardById}
            onUpdate={onUpdateArtifact}
            onDelete={onDeleteArtifact}
            onClose={onClose}
          />
        );
      case 'mcp':
        return (
          <MCPServersTable
            mcpServerById={mcpServerById}
            client={client}
            onCreate={onCreateMCPServer}
            onDelete={onDeleteMCPServer}
          />
        );
      case 'agentic-tools':
        return <AgenticToolsSection client={client} />;
      case 'gateway':
        return (
          <GatewayChannelsTable
            client={client}
            gatewayChannelById={gatewayChannelById}
            branchById={branchById}
            userById={userById}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            onCreate={onCreateGatewayChannel}
            onUpdate={onUpdateGatewayChannel}
            onDelete={onDeleteGatewayChannel}
          />
        );
      case 'groups':
        return <GroupsTable client={client} currentUser={currentUser} userById={userById} />;
      case 'users':
        return (
          <UsersTable
            userById={userById}
            gatewayChannelById={gatewayChannelById}
            client={client}
            currentUser={currentUser}
            onCreate={onCreateUser}
            onUpdate={onUpdateUser}
            onDelete={onDeleteUser}
          />
        );
      case 'about':
        return (
          <AboutTab
            client={client}
            connected={client?.io?.connected ?? false}
            connectionError={undefined}
            isAdmin={hasMinimumRole(currentUser?.role, ROLES.ADMIN)}
          />
        );
      default:
        return null;
    }
  };

  return (
    <Modal
      title={null}
      open={open}
      onCancel={onClose}
      footer={null}
      closable
      width={1200}
      style={{ top: 40 }}
      styles={{
        wrapper: {
          padding: 0,
          overflow: 'hidden',
        },
        container: {
          padding: 0,
          borderRadius: 8,
          overflow: 'hidden',
        },
        header: {
          display: 'none',
        },
        body: {
          padding: 0,
          height: 'calc(100vh - 200px)',
          minHeight: 500,
          maxHeight: 800,
        },
      }}
      closeIcon={<CloseOutlined />}
    >
      <Layout style={{ height: '100%', background: token.colorBgContainer }}>
        <Sider
          width={240}
          style={{
            background: token.colorBgElevated,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            overflow: 'auto',
            padding: '20px 0',
          }}
        >
          <div
            style={{
              padding: '0 24px 16px',
              fontWeight: 600,
              fontSize: 18,
              color: token.colorText,
            }}
          >
            Settings
          </div>
          <Menu
            mode="inline"
            selectedKeys={[activeTab]}
            onClick={({ key }) => {
              if (settingsSectionKeys.has(key)) {
                onTabChange?.(key as SettingsSection);
              }
            }}
            items={menuItems}
            style={{
              border: 'none',
              background: 'transparent',
            }}
          />
        </Sider>
        <Content style={{ padding: '40px 32px 32px', overflow: 'auto' }}>{renderContent()}</Content>
      </Layout>
      <BranchModal
        open={branchModalOpen}
        onClose={handleBranchModalClose}
        branch={selectedBranch}
        repo={selectedRepo}
        sessions={branchSessions}
        boardObjects={boardObjects}
        client={client}
        currentUser={currentUser}
        onUpdateBranch={onUpdateBranch}
        onUpdateRepo={onUpdateRepo}
        onArchiveOrDelete={handleArchiveOrDeleteBranchWithClose}
        onOpenSettings={onClose} // Close branch modal and keep settings modal open
      />
    </Modal>
  );
};
