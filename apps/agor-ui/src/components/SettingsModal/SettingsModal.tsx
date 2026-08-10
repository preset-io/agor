import type {
  AgorClient,
  Artifact,
  Board,
  Branch,
  CreateLocalRepoRequest,
  CreateMCPServerInput,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannelCreateData,
  GatewayChannelPatchData,
  Repo,
  Session,
  TenantAgenticToolName,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import {
  ApiOutlined,
  AppstoreOutlined,
  BranchesOutlined,
  CloseOutlined,
  ClusterOutlined,
  CreditCardOutlined,
  ExperimentOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  RobotOutlined,
  TeamOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Badge, Button, Layout, Menu, Modal, Space, Tag, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../hooks/useSettingsRoute';
import { useAgorStore } from '../../store/agorStore';
import {
  selectArtifactById,
  selectBoardById,
  selectBoardObjectById,
  selectBranchById,
  selectCardById,
  selectCardTypeById,
  selectGatewayChannelById,
  selectMcpServerById,
  selectRepoById,
  selectSessionsByBranch,
  selectUserById,
} from '../../store/selectors';
import { BranchModal } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
import { ToolIcon } from '../ToolIcon';
import { AboutTab } from './AboutTab';
import { AgenticToolsSection, TOOL_LABELS } from './AgenticToolsSection';
import { ArtifactsTable } from './ArtifactsTable';
import { BoardsTable } from './BoardsTable';
import { BranchesTable } from './BranchesTable';
import { CardsTable } from './CardsTable';
import { GatewayChannelsTable } from './GatewayChannelsTable';
import { GroupsTable } from './GroupsTable';
import { MCPServersTable } from './MCPServersTable';
import { ReposTable } from './ReposTable';
import {
  type DrillController,
  type DrillTarget,
  SettingsDrillProvider,
  useDirtyLeaveGuard,
} from './SettingsDrill';
import { TeammatesTable } from './TeammatesTable';
import { UsersTable } from './UsersTable';

const { Sider, Content } = Layout;

// Each agentic tool is its own left-nav entry (mirrors User Settings' AI
// Providers group). The nav keys are prefixed so they can be told apart from
// section keys while sharing the same Menu.
const AGENTIC_NAV_PREFIX = 'agentic:';
const AGENTIC_TOOLS = Object.keys(TOOL_LABELS) as TenantAgenticToolName[];

// Visually-hidden text so a tool's availability is never conveyed by dot color
// alone: assistive tech reads the label while sighted users see the dot.
const SR_ONLY_STYLE: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

export interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  client: AgorClient | null; // Still needed for BranchModal
  currentUser?: User | null; // Current logged-in user
  activeTab?: string; // Control which tab is shown when modal opens
  onTabChange?: (tabKey: string) => void;
  onCreateBoard?: (board: Partial<Board>) => void;
  onUpdateBoard?: (boardId: string, updates: Partial<Board>) => void;
  onDeleteBoard?: (boardId: string) => void;
  onArchiveBoard?: (boardId: string) => void;
  onUnarchiveBoard?: (boardId: string) => void;
  onCreateRepo?: (data: CreateRepoRequest) => unknown;
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
  onCreateGatewayChannel?: (data: GatewayChannelCreateData) => void;
  onUpdateGatewayChannel?: (channelId: string, updates: GatewayChannelPatchData) => void;
  onDeleteGatewayChannel?: (channelId: string) => void;
  onUpdateArtifact?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDeleteArtifact?: (artifactId: string) => void;
  onCreateTeammate?: () => void;
  branchStorageConfig?: BranchStorageConfig;
}

const SettingsModalContent: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  client,
  currentUser,
  activeTab = 'users',
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
  onCreateGatewayChannel,
  onUpdateGatewayChannel,
  onDeleteGatewayChannel,
  onUpdateArtifact,
  onDeleteArtifact,
  onCreateTeammate,
  branchStorageConfig,
}) => {
  // Entity maps come straight from the store rather than through App props:
  // the modal only mounts while open (the exported wrapper returns null when
  // closed), so these subscriptions cost the always-mounted shell nothing and
  // re-render only the open modal on entity patches.
  const boardById = useAgorStore(selectBoardById);
  const boardObjectById = useAgorStore(selectBoardObjectById);
  const repoById = useAgorStore(selectRepoById);
  const branchById = useAgorStore(selectBranchById);
  const sessionsByBranch = useAgorStore(selectSessionsByBranch);
  const userById = useAgorStore(selectUserById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const cardById = useAgorStore(selectCardById);
  const cardTypeById = useAgorStore(selectCardTypeById);
  const gatewayChannelById = useAgorStore(selectGatewayChannelById);
  const artifactById = useAgorStore(selectArtifactById);
  const agenticToolSettingsByName = useAgorStore((state) => state.agenticToolSettingsByName);
  const boardObjects = useMemo(() => mapToArray(boardObjectById), [boardObjectById]);

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

  // Drill-in navigation: the Content pane swaps between a section's list view
  // and its detail/edit view in place, instead of stacking a second Modal. One
  // piece of state owned here decides list-vs-editor; the active editor
  // publishes a controller so the shared footer can drive Save/Cancel.
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [controller, setControllerState] = useState<DrillController | null>(null);
  // Which tool the "Agentic Tools" nav group is focused on. Defaults to the
  // first enabled tool so the panel opens on something actionable.
  const [selectedAgenticTool, setSelectedAgenticTool] = useState<TenantAgenticToolName | null>(
    null
  );
  const activeAgenticTool =
    selectedAgenticTool ??
    AGENTIC_TOOLS.find((t) => agenticToolSettingsByName.get(t)?.enabled !== false) ??
    'claude-code';
  // Mirror the controller into a ref so the leave-guard can read the latest
  // dirty flag without depending on it (keeps the guard identity stable).
  const controllerRef = useRef<DrillController | null>(null);
  const setController = useCallback((next: DrillController | null) => {
    controllerRef.current = next;
    setControllerState(next);
  }, []);
  const getDirty = useCallback(() => controllerRef.current?.dirty ?? false, []);
  const confirmLeaveIfDirty = useDirtyLeaveGuard(getDirty);

  const openDrill = useCallback((target: DrillTarget) => setDrill(target), []);
  const closeDrill = useCallback(() => {
    setDrill(null);
    setController(null);
  }, [setController]);

  // Any external section change (deep link, prop-controlled tab) abandons an
  // open drill-in; leaving the section is the same as backing out of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on section change only
  useEffect(() => {
    setDrill(null);
    setController(null);
  }, [activeTab]);

  const handleNavClick = useCallback(
    (key: string) => {
      // Per-tool Agentic Tools entries route to the shared 'agentic-tools'
      // section and set which tool's panel shows.
      const isAgenticTool = key.startsWith(AGENTIC_NAV_PREFIX);
      const targetSection: SettingsSection = isAgenticTool
        ? 'agentic-tools'
        : (key as SettingsSection);
      if (!isAgenticTool && !settingsSectionKeys.has(key)) return;
      const alreadyThere =
        targetSection === activeTab &&
        (!isAgenticTool || activeAgenticTool === key.slice(AGENTIC_NAV_PREFIX.length));
      if (alreadyThere) return;
      const go = () => {
        closeDrill();
        if (isAgenticTool) {
          setSelectedAgenticTool(key.slice(AGENTIC_NAV_PREFIX.length) as TenantAgenticToolName);
        }
        if (targetSection !== activeTab) onTabChange?.(targetSection);
      };
      if (drill) {
        void confirmLeaveIfDirty().then((ok) => ok && go());
      } else {
        go();
      }
    },
    [
      activeAgenticTool,
      activeTab,
      closeDrill,
      confirmLeaveIfDirty,
      drill,
      onTabChange,
      settingsSectionKeys,
    ]
  );

  const handleModalClose = useCallback(() => {
    if (drill) {
      void confirmLeaveIfDirty().then((ok) => {
        if (ok) {
          closeDrill();
          onClose();
        }
      });
    } else {
      onClose();
    }
  }, [closeDrill, confirmLeaveIfDirty, drill, onClose]);

  const drillFooter = controller
    ? [
        <Button key="cancel" onClick={controller.onBack} disabled={controller.saving}>
          Cancel
        </Button>,
        controller.onSave ? (
          <Button
            key="save"
            type="primary"
            loading={controller.saving}
            onClick={() => void controller.onSave?.()}
          >
            {controller.saveLabel ?? 'Save'}
          </Button>
        ) : null,
      ]
    : null;

  // Role gate — MCP Servers and Gateway Channels are global admin-managed
  // configuration (credentials, webhook URLs, env vars). The daemon enforces
  // ADMIN role on writes for both services (see register-hooks.ts); hiding
  // the menu entries here avoids showing members a tab where every action
  // would 403.
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  // Menu items for left sidebar navigation.
  //
  // People leads: access — who can see and do what — is the first thing an admin
  // checks. Groups stays admin-only within People. Integrations is admin-only as
  // a whole and carries the sole "Admin" cue (on the group label) so the visual
  // marker lives in exactly one place, not repeated on panel or drill-in headers.
  const menuItems: MenuProps['items'] = useMemo(
    () => [
      {
        key: 'people',
        label: 'People',
        type: 'group' as const,
        children: [
          {
            key: 'users',
            label: 'Users',
            icon: <TeamOutlined />,
          },
          ...(isAdmin
            ? [
                {
                  key: 'groups',
                  label: 'Groups',
                  icon: <ClusterOutlined />,
                },
              ]
            : []),
        ],
      },
      {
        key: 'resources',
        label: 'Resources',
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
            key: 'teammates',
            label: 'Teammates',
            icon: <RobotOutlined />,
          },
          {
            key: 'artifacts',
            label: 'Artifacts',
            icon: <ExperimentOutlined />,
          },
          {
            key: 'cards',
            label: (
              <span>
                Cards{' '}
                <Tag
                  color="warning"
                  style={{ marginInlineStart: token.marginXXS, fontSize: token.fontSizeSM }}
                >
                  Beta
                </Tag>
              </span>
            ),
            icon: <CreditCardOutlined />,
          },
        ],
      },
      // Agentic Tools is its own group: one nav entry per tool with an
      // enabled/disabled status dot, mirroring User Settings' AI Providers. This
      // replaces the old nested tool-Tabs-inside-a-Tabs anti-pattern.
      ...(isAdmin
        ? [
            {
              key: 'agentic-tools-group',
              label: (
                <span>
                  Agentic Tools{' '}
                  <Tag style={{ marginInlineStart: token.marginXXS, fontSize: token.fontSizeSM }}>
                    Admin
                  </Tag>
                </span>
              ),
              type: 'group' as const,
              children: AGENTIC_TOOLS.map((tool) => {
                const enabled = agenticToolSettingsByName.get(tool)?.enabled !== false;
                return {
                  key: `${AGENTIC_NAV_PREFIX}${tool}`,
                  icon: <ToolIcon tool={tool} size={16} />,
                  label: (
                    <Space size={8}>
                      <Badge color={enabled ? token.colorSuccess : token.colorTextQuaternary} />
                      <span>{TOOL_LABELS[tool]}</span>
                      <span style={SR_ONLY_STYLE}>{enabled ? 'Available' : 'Disabled'}</span>
                    </Space>
                  ),
                };
              }),
            },
            {
              key: 'integrations',
              label: (
                <span>
                  Integrations{' '}
                  <Tag style={{ marginInlineStart: token.marginXXS, fontSize: token.fontSizeSM }}>
                    Admin
                  </Tag>
                </span>
              ),
              type: 'group' as const,
              children: [
                {
                  key: 'mcp',
                  label: 'MCP Servers',
                  icon: <ApiOutlined />,
                },
                {
                  key: 'gateway',
                  label: 'Gateway Channels',
                  icon: <MessageOutlined />,
                },
              ],
            },
          ]
        : []),
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
    [isAdmin, token, agenticToolSettingsByName]
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
      case 'teammates':
        return (
          <TeammatesTable
            branchById={branchById}
            repoById={repoById}
            boardById={boardById}
            sessionsByBranch={sessionsByBranch}
            userById={userById}
            onArchiveOrDelete={onArchiveOrDeleteBranch}
            onRowClick={handleBranchRowClick}
            onCreateTeammate={onCreateTeammate ?? onCreateTeammate}
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
        return <AgenticToolsSection client={client} tool={activeAgenticTool} />;
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
      // The header bar is hidden (styles.header) but the dialog still needs an
      // accessible name; `title` becomes rc-dialog's aria-labelledby target.
      title="Workspace Settings"
      open={open}
      onCancel={handleModalClose}
      footer={drillFooter}
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
        footer: {
          margin: 0,
          padding: '12px 24px',
          background: token.colorBgContainer,
          borderTop: `1px solid ${token.colorBorderSecondary}`,
        },
      }}
      closeIcon={<CloseOutlined />}
    >
      <SettingsDrillProvider
        drill={drill}
        openDrill={openDrill}
        closeDrill={closeDrill}
        confirmLeaveIfDirty={confirmLeaveIfDirty}
        controller={controller}
        setController={setController}
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
              selectedKeys={[
                activeTab === 'agentic-tools'
                  ? `${AGENTIC_NAV_PREFIX}${activeAgenticTool}`
                  : activeTab,
              ]}
              onClick={({ key }) => handleNavClick(key)}
              items={menuItems}
              style={{
                border: 'none',
                background: 'transparent',
              }}
            />
          </Sider>
          <Content style={{ padding: '40px 32px 32px', overflow: 'auto' }}>
            {renderContent()}
          </Content>
        </Layout>
      </SettingsDrillProvider>
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

export const SettingsModal: React.FC<SettingsModalProps> = (props) => {
  if (!props.open) return null;
  return <SettingsModalContent {...props} />;
};
