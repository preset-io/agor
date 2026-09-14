import type {
  AgorClient,
  Artifact,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  CreateLocalRepoRequest,
  CreateMCPServerInput,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannelCreateData,
  GatewayChannelPatchData,
  Repo,
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
  ControlOutlined,
  CreditCardOutlined,
  ExperimentOutlined,
  ExportOutlined,
  FolderOutlined,
  InfoCircleOutlined,
  MessageOutlined,
  RobotOutlined,
  TeamOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Layout, Menu, Modal, Tag, theme } from 'antd';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useMCPCatalogModal } from '@/contexts/MCPCatalogModalContext';
import { useAuthenticatedAuthorityScope } from '@/hooks/useAuthorityOperationGuard';
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
import type { AgenticToolOption } from '../../types';
import { BranchModal } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
import type { TeammateTabResult } from '../CreateDialog/tabs/TeammateTab';
import { AboutTab } from './AboutTab';
import { AgenticToolsSection } from './AgenticToolsSection';
import { AllCardsPanel } from './AllCardsPanel';
import { ArtifactsTable } from './ArtifactsTable';
import { BoardsTable } from './BoardsTable';
import { BranchesTable } from './BranchesTable';
import { CardTypesPanel } from './CardTypesPanel';
import { GatewayChannelsTable } from './GatewayChannelsTable';
import { GroupsTable } from './GroupsTable';
import { ReposTable } from './ReposTable';
import {
  type DrillController,
  type DrillTarget,
  SettingsDrillProvider,
  useDirtyLeaveGuard,
} from './SettingsDrill';
import { type TeammateCreateProgress, TeammatesTable } from './TeammatesTable';
import { UsersTable } from './UsersTable';
import { WorkspacePreferencesTab } from './WorkspacePreferencesTab';

const { Sider, Content } = Layout;

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
  onCreateRepo?: (data: CreateRepoRequest, shouldApply?: () => boolean) => unknown;
  onCreateLocalRepo?: (
    data: CreateLocalRepoRequest,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onUpdateRepo?: (repoId: string, updates: Partial<Repo>, shouldApply?: () => boolean) => void;
  onDeleteRepo?: (repoId: string, cleanup: boolean, shouldApply?: () => boolean) => void;
  onArchiveOrDeleteBranch?: (branchId: string, options: BranchArchiveOrDeleteOptions) => void;
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
  onCreateUser?: (data: CreateUserInput, shouldApply?: () => boolean) => void | Promise<void>;
  onUpdateUser?: (
    userId: string,
    updates: UpdateUserInput,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onDeleteUser?: (userId: string, shouldApply?: () => boolean) => void | Promise<void>;
  onCreateMCPServer?: (
    data: CreateMCPServerInput,
    shouldApply?: () => boolean
  ) => void | Promise<void>;
  onDeleteMCPServer?: (serverId: string, shouldApply?: () => boolean) => void | Promise<void>;
  onCreateGatewayChannel?: (data: GatewayChannelCreateData) => void;
  onUpdateGatewayChannel?: (
    channelId: string,
    updates: GatewayChannelPatchData,
    shouldApply?: () => boolean
  ) => void;
  onDeleteGatewayChannel?: (channelId: string, shouldApply?: () => boolean) => void;
  onUpdateArtifact?: (artifactId: string, updates: Partial<Artifact>) => void;
  onDeleteArtifact?: (artifactId: string) => void;
  onCreateTeammate?: (
    result: TeammateTabResult,
    progress?: TeammateCreateProgress
  ) => Promise<void>;
  availableAgents?: AgenticToolOption[];
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
  onCreateGatewayChannel,
  onUpdateGatewayChannel,
  onDeleteGatewayChannel,
  onUpdateArtifact,
  onDeleteArtifact,
  onCreateTeammate,
  availableAgents,
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
  const boardObjects = useMemo(() => mapToArray(boardObjectById), [boardObjectById]);
  const settingsAuthority = useAuthenticatedAuthorityScope(
    client,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );

  const { token } = theme.useToken();
  // MCP config lives in the MCP Marketplace, which is now a modal (opened via
  // this context) rather than the old /marketplace route.
  const catalog = useMCPCatalogModal();
  const settingsSectionKeys = useMemo(() => new Set<string>(SETTINGS_SECTIONS), []);

  // Drill-in navigation: the Content pane swaps between a section's list view
  // and its detail/edit view in place, instead of stacking a second Modal. One
  // piece of state owned here decides list-vs-editor; the active editor
  // publishes a controller so the shared footer can drive Save/Cancel.
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const [controller, setControllerState] = useState<DrillController | null>(null);
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

  // Branches and Teammates edit the same entity (a branch) via the shared
  // BranchModal, now rendered in-place (embedded) as the section's drill-in
  // instead of a stacked modal. The record is resolved live from the store so
  // it stays fresh while open.
  const branchDrill =
    drill?.mode === 'edit' && (drill.kind === 'branches' || drill.kind === 'teammates')
      ? (branchById.get(drill.recordId ?? '') ?? null)
      : null;

  const handleArchiveOrDeleteBranchFromDrill = useCallback(
    async (branchId: string, options: BranchArchiveOrDeleteOptions) => {
      await onArchiveOrDeleteBranch?.(branchId, options);
      closeDrill();
    },
    [onArchiveOrDeleteBranch, closeDrill]
  );

  // Any external section change (deep link, prop-controlled tab) abandons an
  // open drill-in; leaving the section is the same as backing out of it.
  // biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on section change only
  useEffect(() => {
    setDrill(null);
    setController(null);
  }, [activeTab]);

  const handleNavClick = useCallback(
    (key: string) => {
      // MCP server configuration lives in the MCP Marketplace, opened as a modal
      // (its own context) rather than a Settings section. This entry points to it.
      if (key === 'mcp-marketplace') {
        const openIt = () => {
          catalog?.openCatalog();
          onClose();
        };
        if (drill) {
          void confirmLeaveIfDirty().then((ok) => ok && openIt());
        } else {
          openIt();
        }
        return;
      }
      if (!settingsSectionKeys.has(key)) return;
      if (key === activeTab) return;
      const go = () => {
        closeDrill();
        onTabChange?.(key as SettingsSection);
      };
      if (drill) {
        void confirmLeaveIfDirty().then((ok) => ok && go());
      } else {
        go();
      }
    },
    [
      activeTab,
      catalog,
      closeDrill,
      confirmLeaveIfDirty,
      drill,
      onClose,
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

  const drillFooter =
    controller && !controller.ownsFooter
      ? [
          <Button key="cancel" onClick={controller.onBack} disabled={controller.saving}>
            Cancel
          </Button>,
          controller.onSave ? (
            <Button
              key="save"
              type="primary"
              loading={controller.saving}
              disabled={controller.saveDisabled}
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
  //
  // The MCP Servers tab is offered to everyone. What a member may do there is
  // the tenant's `mcp_member_policy`, which members may read precisely so a
  // refusal is legible to the person it refuses; the tab shows them that
  // policy and the servers they can already use.
  const isAdmin = hasMinimumRole(currentUser?.role, ROLES.ADMIN);

  // The daemon serves the user roster to members
  // (`ensureMinimumRole(params, ROLES.MEMBER, 'list users')`), so Users stays
  // visible to them; UsersTable exposes only the mutations their role can
  // perform. Viewers rank below MEMBER and get no Users entry at all.
  const canListUsers = hasMinimumRole(currentUser?.role, ROLES.MEMBER);

  // One answer for "may this role open this section", read by both the menu and
  // renderContent, so a URL-routable section can't be reached with nothing
  // selected in the sidebar.
  const canSeeSection = useCallback(
    (section: string): boolean => {
      switch (section) {
        case 'agentic-tools':
        case 'gateway':
        case 'groups':
        case 'workspace-preferences':
          return isAdmin;
        case 'users':
          return canListUsers;
        default:
          return true;
      }
    },
    [isAdmin, canListUsers]
  );

  // Menu items for left sidebar navigation. People leads (access first), then
  // Resources, then Integrations, then Admin.

  const menuItems: MenuProps['items'] = useMemo(
    () => [
      // People leads: who has access is the first thing an admin checks. Users
      // is visible to any member (the daemon serves the roster to them); Groups
      // is admin-only.
      ...(canListUsers || isAdmin
        ? [
            {
              key: 'people',
              label: 'People',
              type: 'group' as const,
              children: [
                ...(canListUsers ? [{ key: 'users', label: 'Users', icon: <TeamOutlined /> }] : []),
                ...(isAdmin ? [{ key: 'groups', label: 'Groups', icon: <ClusterOutlined /> }] : []),
              ],
            },
          ]
        : []),
      {
        key: 'resources',
        label: 'Resources',
        type: 'group' as const,
        children: [
          { key: 'boards', label: 'Boards', icon: <AppstoreOutlined /> },
          { key: 'repos', label: 'Repositories', icon: <FolderOutlined /> },
          { key: 'branches', label: 'Branches', icon: <BranchesOutlined /> },
          { key: 'teammates', label: 'Teammates', icon: <RobotOutlined /> },
          { key: 'artifacts', label: 'Artifacts', icon: <ExperimentOutlined /> },
          ...(isAdmin
            ? [{ key: 'workspace-preferences', label: 'Preferences', icon: <ControlOutlined /> }]
            : []),
        ],
      },
      {
        key: 'cards-group',
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
        type: 'group' as const,
        children: [
          { key: 'card-types', label: 'Card Types', icon: <CreditCardOutlined /> },
          { key: 'cards', label: 'All Cards', icon: <AppstoreOutlined /> },
        ],
      },
      // Integrations (admin-only): Agentic Tools, the MCP Marketplace pointer,
      // and Gateway Channels. MCP servers are configured in the Marketplace modal
      // now, so this points out to it rather than leaving a dead end where the
      // MCP Servers table used to be.
      ...(isAdmin
        ? [
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
                ...(canSeeSection('agentic-tools')
                  ? [
                      {
                        key: 'agentic-tools',
                        label: 'Agentic Tools',
                        icon: <ThunderboltOutlined />,
                      },
                    ]
                  : []),
                {
                  key: 'mcp-marketplace',
                  label: (
                    <span>
                      MCP Marketplace{' '}
                      <ExportOutlined
                        style={{ fontSize: token.fontSizeSM, color: token.colorTextTertiary }}
                      />
                    </span>
                  ),
                  icon: <ApiOutlined />,
                },
                ...(canSeeSection('gateway')
                  ? [{ key: 'gateway', label: 'Gateway Channels', icon: <MessageOutlined /> }]
                  : []),
              ],
            },
          ]
        : []),
      {
        key: 'system',
        label: 'System',
        type: 'group' as const,
        children: [{ key: 'about', label: 'About', icon: <InfoCircleOutlined /> }],
      },
    ],
    [canSeeSection, canListUsers, isAdmin, token]
  );

  // The shared BranchModal, rendered in-place as the drill-in for both the
  // Branches and Teammates sections (embedded → no stacked modal).
  const branchEditor = branchDrill ? (
    <BranchModal
      embedded
      open
      onClose={closeDrill}
      branch={branchDrill}
      repo={repoById.get(branchDrill.repo_id) ?? null}
      sessions={sessionsByBranch.get(branchDrill.branch_id) ?? []}
      boardObjects={boardObjects}
      client={client}
      currentUser={currentUser}
      onUpdateBranch={onUpdateBranch}
      onUpdateRepo={onUpdateRepo}
      onArchiveOrDelete={handleArchiveOrDeleteBranchFromDrill}
      onOpenSettings={() => {
        closeDrill();
        onTabChange?.('repos');
      }}
    />
  ) : null;

  // Render content based on active section
  const renderContent = () => {
    // A gated section is routable, so this is reachable by URL even with no
    // menu entry to click. Same answer in both places.
    if (!canSeeSection(activeTab)) return null;

    switch (activeTab) {
      case 'boards':
        return (
          <BoardsTable
            client={client}
            boardById={boardById}
            sessionsByBranch={sessionsByBranch}
            branchById={branchById}
            currentUser={currentUser}
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
          branchEditor ?? (
            <BranchesTable
              client={client}
              branchById={branchById}
              repoById={repoById}
              boardById={boardById}
              sessionsByBranch={sessionsByBranch}
              onArchiveOrDelete={onArchiveOrDeleteBranch}
              onUnarchive={onUnarchiveBranch}
              onCreate={onCreateBranch}
              onRowClick={(branch) =>
                openDrill({ kind: 'branches', mode: 'edit', recordId: branch.branch_id })
              }
              onStartEnvironment={onStartEnvironment}
              onStopEnvironment={onStopEnvironment}
              onClose={onClose}
              branchStorageConfig={branchStorageConfig}
            />
          )
        );
      case 'teammates':
        return (
          branchEditor ?? (
            <TeammatesTable
              branchById={branchById}
              repoById={repoById}
              boardById={boardById}
              sessionsByBranch={sessionsByBranch}
              userById={userById}
              onArchiveOrDelete={onArchiveOrDeleteBranch}
              onRowClick={(branch) =>
                openDrill({ kind: 'teammates', mode: 'edit', recordId: branch.branch_id })
              }
              onCreateTeammate={onCreateTeammate}
              availableAgents={availableAgents}
              onCreateRepo={onCreateRepo}
              mcpServerById={mcpServerById}
              currentUser={currentUser}
              client={client}
              onClose={onClose}
            />
          )
        );
      case 'card-types':
        return <CardTypesPanel client={client} cardTypeById={cardTypeById} />;
      case 'cards':
        return (
          <AllCardsPanel
            client={client}
            cardById={cardById}
            cardTypeById={cardTypeById}
            boardById={boardById}
            boardObjects={boardObjects}
            onClose={onClose}
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
      case 'workspace-preferences':
        return <WorkspacePreferencesTab client={client} currentUser={currentUser} />;
      case 'agentic-tools':
        return (
          <AgenticToolsSection
            client={client}
            identityKey={settingsAuthority.identityKey}
            operationScope={settingsAuthority.operationScope}
          />
        );
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
          borderRadius: token.borderRadiusLG,
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
            {/* Text-only label: at the 240px Sider width the icon + text wrapped
                to two lines, so the leading icon was dropped. This header is the
                only chrome that never scrolls away inside a drill-in, so the
                distinct wording — "Workspace Settings" vs "User Settings" — is
                what now marks the surface at a glance. Mirrored in UserSettingsModal. */}
            <div style={{ padding: '0 24px 16px' }}>
              <span style={{ fontWeight: 600, fontSize: 18, color: token.colorText }}>
                Workspace Settings
              </span>
            </div>
            <Menu
              mode="inline"
              selectedKeys={[activeTab]}
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
    </Modal>
  );
};

export const SettingsModal: React.FC<SettingsModalProps> = (props) => {
  if (!props.open) return null;
  // Settings contains other caller-private editors (gateway credentials,
  // environment values, selected records) besides MCP. Destroy the whole
  // modal state tree on an in-place identity replacement. Connection and
  // token churn for the same user deliberately retain the tree.
  return (
    <SettingsModalContent
      key={props.currentUser?.user_id ?? '__no-authenticated-user__'}
      {...props}
    />
  );
};
