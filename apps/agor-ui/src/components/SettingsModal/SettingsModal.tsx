import type {
  AgorClient,
  Artifact,
  Board,
  BoardEntityObject,
  CardType,
  CardWithType,
  CreateMCPServerInput,
  CreateUserInput,
  GatewayChannel,
  MCPServer,
  Repo,
  Session,
  UpdateMCPServerInput,
  UpdateUserInput,
  User,
  Worktree,
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
import { useServiceEnabled } from '../../hooks/useServicesConfig';
import { WorktreeModal } from '../WorktreeModal';
import type { WorktreeUpdate } from '../WorktreeModal/tabs/GeneralTab';
import { AboutTab } from './AboutTab';
import { AgenticToolsSection } from './AgenticToolsSection';
import { ArtifactsTable } from './ArtifactsTable';
import { AssistantsTable } from './AssistantsTable';
import { BoardsTable } from './BoardsTable';
import { CardsTable } from './CardsTable';
import { GatewayChannelsTable } from './GatewayChannelsTable';
import { MCPServersTable } from './MCPServersTable';
import { ReposTable } from './ReposTable';
import { UsersTable } from './UsersTable';
import { WorktreesTable } from './WorktreesTable';

const { Sider, Content } = Layout;

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null; // Still needed for WorktreeModal
  currentUser?: User | null; // Current logged-in user
  boardById: Map<string, Board>;
  boardObjects: BoardEntityObject[];
  repoById: Map<string, Repo>;
  worktreeById: Map<string, Worktree>;
  sessionById: Map<string, Session>; // O(1) ID lookups - efficient, stable references
  sessionsByWorktree: Map<string, Session[]>; // O(1) worktree filtering
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
  onCreateRepo?: (data: { url: string; slug: string; default_branch: string }) => void;
  onCreateLocalRepo?: (data: { path: string; slug?: string }) => void;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>) => void;
  onDeleteRepo?: (repoId: string, cleanup: boolean) => void;
  onArchiveOrDeleteWorktree?: (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => void;
  onUnarchiveWorktree?: (worktreeId: string, options?: { boardId?: string }) => void;
  onUpdateWorktree?: (worktreeId: string, updates: WorktreeUpdate) => void;
  onCreateWorktree?: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      issue_url?: string;
      pull_request_url?: string;
    }
  ) => Promise<Worktree | null>;
  onStartEnvironment?: (worktreeId: string) => void;
  onStopEnvironment?: (worktreeId: string) => void;
  onCreateUser?: (data: CreateUserInput) => void;
  onUpdateUser?: (userId: string, updates: UpdateUserInput) => void;
  onDeleteUser?: (userId: string) => void;
  onCreateMCPServer?: (data: CreateMCPServerInput) => void;
  onUpdateMCPServer?: (serverId: string, updates: UpdateMCPServerInput) => void;
  onDeleteMCPServer?: (serverId: string) => void;
  gatewayChannelById?: Map<string, GatewayChannel>;
  onCreateGatewayChannel?: (data: Partial<GatewayChannel>) => void;
  onUpdateGatewayChannel?: (channelId: string, updates: Partial<GatewayChannel>) => void;
  onDeleteGatewayChannel?: (channelId: string) => void;
  artifactById?: Map<string, Artifact>;
  onUpdateArtifact?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDeleteArtifact?: (artifactId: string) => void;
}

export const SettingsModal: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  client,
  currentUser,
  boardById,
  boardObjects,
  repoById,
  worktreeById,
  sessionsByWorktree,
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
  onArchiveOrDeleteWorktree,
  onUnarchiveWorktree,
  onUpdateWorktree,
  onCreateWorktree,
  onStartEnvironment,
  onStopEnvironment,
  onCreateUser,
  onUpdateUser,
  onDeleteUser,
  onCreateMCPServer,
  onUpdateMCPServer,
  onDeleteMCPServer,
  gatewayChannelById = new Map(),
  onCreateGatewayChannel,
  onUpdateGatewayChannel,
  onDeleteGatewayChannel,
  artifactById = new Map(),
  onUpdateArtifact,
  onDeleteArtifact,
}) => {
  const [selectedWorktree, setSelectedWorktree] = useState<Worktree | null>(null);
  const [selectedRepo, setSelectedRepo] = useState<Repo | null>(null);
  const [worktreeSessions, setWorktreeSessions] = useState<Session[]>([]);
  const [worktreeModalOpen, setWorktreeModalOpen] = useState(false);

  const handleWorktreeRowClick = (worktree: Worktree) => {
    // Snapshot the data when opening modal
    setSelectedWorktree(worktree);
    setSelectedRepo(repoById.get(worktree.repo_id) || null);
    setWorktreeSessions(sessionsByWorktree.get(worktree.worktree_id) || []);
    setWorktreeModalOpen(true);
  };

  const handleWorktreeModalClose = () => {
    setWorktreeModalOpen(false);
    // Clear after modal closes
    setSelectedWorktree(null);
    setSelectedRepo(null);
    setWorktreeSessions([]);
  };

  // Wrapper to close modal after archive/delete
  const handleArchiveOrDeleteWorktreeWithClose = async (
    worktreeId: string,
    options: {
      metadataAction: 'archive' | 'delete';
      filesystemAction: 'preserved' | 'cleaned' | 'deleted';
    }
  ) => {
    await onArchiveOrDeleteWorktree?.(worktreeId, options);
    handleWorktreeModalClose();
  };

  const { token } = theme.useToken();

  // Service tier gates — hide tabs for disabled services
  const gatewayEnabled = useServiceEnabled('gateway');
  const mcpEnabled = useServiceEnabled('mcp_servers');
  const artifactsEnabled = useServiceEnabled('artifacts');
  const cardsEnabled = useServiceEnabled('cards');

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
            key: 'worktrees',
            label: 'Worktrees',
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
          ...(mcpEnabled
            ? [
                {
                  key: 'mcp',
                  label: 'MCP Servers',
                  icon: <ApiOutlined />,
                },
              ]
            : []),
          {
            key: 'agentic-tools',
            label: 'Agentic Tools',
            icon: <ThunderboltOutlined />,
          },
          ...(gatewayEnabled
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
    [gatewayEnabled, mcpEnabled, artifactsEnabled, cardsEnabled, token]
  );

  // Render content based on active section
  const renderContent = () => {
    switch (activeTab) {
      case 'boards':
        return (
          <BoardsTable
            client={client}
            boardById={boardById}
            sessionsByWorktree={sessionsByWorktree}
            worktreeById={worktreeById}
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
      case 'worktrees':
        return (
          <WorktreesTable
            worktreeById={worktreeById}
            repoById={repoById}
            boardById={boardById}
            sessionsByWorktree={sessionsByWorktree}
            onArchiveOrDelete={onArchiveOrDeleteWorktree}
            onUnarchive={onUnarchiveWorktree}
            onCreate={onCreateWorktree}
            onRowClick={handleWorktreeRowClick}
            onStartEnvironment={onStartEnvironment}
            onStopEnvironment={onStopEnvironment}
          />
        );
      case 'assistants':
        return (
          <AssistantsTable
            worktreeById={worktreeById}
            repoById={repoById}
            boardById={boardById}
            sessionsByWorktree={sessionsByWorktree}
            client={client}
            onArchiveOrDelete={onArchiveOrDeleteWorktree}
            onRowClick={handleWorktreeRowClick}
            onCreateWorktree={onCreateWorktree}
            onUpdateWorktree={onUpdateWorktree}
            onCreateRepo={onCreateRepo}
            onStartEnvironment={onStartEnvironment}
            onStopEnvironment={onStopEnvironment}
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
            worktreeById={worktreeById}
            boardById={boardById}
            onUpdate={onUpdateArtifact}
            onDelete={onDeleteArtifact}
          />
        );
      case 'mcp':
        return (
          <MCPServersTable
            mcpServerById={mcpServerById}
            client={client}
            onCreate={onCreateMCPServer}
            onUpdate={onUpdateMCPServer}
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
            worktreeById={worktreeById}
            userById={userById}
            mcpServerById={mcpServerById}
            currentUser={currentUser}
            onCreate={onCreateGatewayChannel}
            onUpdate={onUpdateGatewayChannel}
            onDelete={onDeleteGatewayChannel}
          />
        );
      case 'users':
        return (
          <UsersTable
            userById={userById}
            mcpServerById={mcpServerById}
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
            onClick={({ key }) => onTabChange?.(key)}
            items={menuItems}
            style={{
              border: 'none',
              background: 'transparent',
            }}
          />
        </Sider>
        <Content style={{ padding: '40px 32px 32px', overflow: 'auto' }}>{renderContent()}</Content>
      </Layout>
      <WorktreeModal
        open={worktreeModalOpen}
        onClose={handleWorktreeModalClose}
        worktree={selectedWorktree}
        repo={selectedRepo}
        sessions={worktreeSessions}
        boardById={boardById}
        boardObjects={boardObjects}
        mcpServerById={mcpServerById}
        client={client}
        currentUser={currentUser}
        onUpdateWorktree={onUpdateWorktree}
        onUpdateRepo={onUpdateRepo}
        onArchiveOrDelete={handleArchiveOrDeleteWorktreeWithClose}
        onOpenSettings={onClose} // Close worktree modal and keep settings modal open
      />
    </Modal>
  );
};
