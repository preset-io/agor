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
  Session,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { ArrowLeftOutlined, CloseOutlined, RightOutlined, UserOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Drawer, Flex, Grid, Layout, Menu, Modal, Typography, theme } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useAuthenticatedAuthorityScope } from '@/hooks/useAuthorityOperationGuard';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
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
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { BranchModal } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
import { AboutTab } from './AboutTab';
import { AgenticToolsSection } from './AgenticToolsSection';
import { ArtifactsTable } from './ArtifactsTable';
import { BoardsTable } from './BoardsTable';
import { BranchesTable } from './BranchesTable';
import { CardsTable } from './CardsTable';
import { GatewayChannelsTable } from './GatewayChannelsTable';
import { GroupsTable } from './GroupsTable';
import { MCPServersTable } from './MCPServersTable';
import { ReposTable } from './ReposTable';
import { buildSettingsNav, settingsSectionMobileLabel } from './settingsNavigation';
import { TeammatesTable } from './TeammatesTable';
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
  onCreateTeammate?: () => void;
  branchStorageConfig?: BranchStorageConfig;
}

const SettingsModalContent: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  client,
  currentUser,
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
  const boardObjects = useMemo(() => mapToArray(boardObjectById), [boardObjectById]);
  const settingsAuthority = useAuthenticatedAuthorityScope(
    client,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );

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
    options: BranchArchiveOrDeleteOptions
  ) => {
    await onArchiveOrDeleteBranch?.(branchId, options);
    handleBranchModalClose();
  };

  const { token } = theme.useToken();
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const reducedMotion = usePrefersReducedMotion();
  const settingsSectionKeys = useMemo(() => new Set<string>(SETTINGS_SECTIONS), []);

  // Role gate — Agentic Tools and Gateway Channels are global admin-managed
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

  // The Users tab follows the MCP Servers pattern rather than the Agentic Tools
  // one: the daemon deliberately serves the roster to members
  // (`ensureMinimumRole(params, ROLES.MEMBER, 'list users')`), so seeing who is
  // on the team is not something to take away. UsersTable separately exposes
  // only the mutations the current role has authority to perform.
  //
  // Viewers rank below MEMBER, so the listing itself would 403 for them; they
  // get no entry at all.
  const canListUsers = hasMinimumRole(currentUser?.role, ROLES.MEMBER);

  // One answer for "may this role open this section", read by both the menu and
  // the content below. Every gated section is routable via useSettingsRoute, so
  // gating only the menu leaves the pane reachable by URL with nothing selected
  // in the sidebar — which is what `groups`, `gateway` and `agentic-tools`
  // already did. Deriving both from this set is what stops the two from
  // drifting apart again the next time a section is gated.
  const canSeeSection = useCallback(
    (section: string): boolean => {
      switch (section) {
        case 'agentic-tools':
        case 'gateway':
        case 'groups':
          return isAdmin;
        case 'users':
          return canListUsers;
        default:
          return true;
      }
    },
    [isAdmin, canListUsers]
  );

  // One nav model feeds the desktop sidebar and the mobile index, so they cannot drift apart
  const settingsNav = useMemo(
    () =>
      buildSettingsNav({
        isAdmin,
        canSeeSection,
        counts: {
          boards: boardById.size,
          repos: repoById.size,
          branches: branchById.size,
          cards: cardById.size,
          artifacts: artifactById.size,
          mcp: mcpServerById.size,
          gateway: gatewayChannelById.size,
          users: userById.size,
        },
      }),
    [
      canSeeSection,
      isAdmin,
      boardById.size,
      repoById.size,
      branchById.size,
      cardById.size,
      artifactById.size,
      mcpServerById.size,
      gatewayChannelById.size,
      userById.size,
    ]
  );

  // Menu items for left sidebar navigation
  const menuItems: MenuProps['items'] = useMemo(
    () =>
      settingsNav.map((group) => ({
        key: group.key,
        label: group.title,
        type: 'group' as const,
        children: group.rows.map((row) => ({
          key: row.section,
          icon: row.icon,
          label: row.beta ? (
            <span>
              {row.label}{' '}
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
          ) : (
            row.label
          ),
        })),
      })),
    [settingsNav, token]
  );

  // Mobile drill state: null = the grouped index. A deep-link opener (e.g. the
  // "Create teammate" flow) seeds straight into its section; the generic entry
  // (default 'boards') opens on the index. The desktop Modal path ignores this.
  const [mobileSection, setMobileSection] = useState<SettingsSection | null>(() =>
    activeTab &&
    activeTab !== 'boards' &&
    (SETTINGS_SECTIONS as readonly string[]).includes(activeTab)
      ? (activeTab as SettingsSection)
      : null
  );

  const drillIntoSection = useCallback(
    (section: SettingsSection) => {
      setMobileSection(section);
      onTabChange?.(section);
    },
    [onTabChange]
  );

  // Shared iOS-style grouped-list card wrapper for the mobile index.
  const settingsGroupCardStyle: React.CSSProperties = {
    marginTop: token.marginXS,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    background: token.colorBgContainer,
    overflow: 'hidden',
  };

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
            canConfigureCleanup={isAdmin}
            repoById={repoById}
            identityKey={settingsAuthority.identityKey}
            operationScope={settingsAuthority.operationScope}
            onCreate={onCreateRepo}
            onCreateLocal={onCreateLocalRepo}
            onUpdate={onUpdateRepo}
            onDelete={onDeleteRepo}
          />
        );
      case 'branches':
        return (
          <BranchesTable
            currentUser={currentUser}
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
            client={client}
            currentUser={currentUser}
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
      case 'workspace-preferences':
        return <WorkspacePreferencesTab client={client} currentUser={currentUser} />;
      case 'mcp':
        return (
          <MCPServersTable
            mcpServerById={mcpServerById}
            client={client}
            userById={userById}
            currentUser={currentUser}
            onCreate={onCreateMCPServer}
            onDelete={onDeleteMCPServer}
          />
        );
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

  if (compact) {
    return (
      <Drawer
        title={null}
        aria-label="Workspace settings"
        closable={false}
        placement="bottom"
        // Full-bleed so the settings surface covers the app header instead of
        // leaving a stale title peeking above it.
        height="100dvh"
        {...reducedMotionSurface(reducedMotion)}
        open={open}
        onClose={onClose}
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        <Layout style={{ height: '100%', background: token.colorBgContainer }}>
          <Flex
            align="center"
            gap={token.marginXS}
            style={{
              padding: `${token.paddingSM}px ${token.paddingSM}px`,
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgElevated,
              flex: '0 0 auto',
            }}
          >
            {mobileSection ? (
              <Button
                type="text"
                icon={<ArrowLeftOutlined />}
                aria-label="Back"
                onClick={() => setMobileSection(null)}
                style={{ minWidth: MOBILE_TOUCH_TARGET, minHeight: MOBILE_TOUCH_TARGET }}
              />
            ) : (
              <div style={{ width: MOBILE_TOUCH_TARGET }} />
            )}
            <Typography.Title
              level={5}
              ellipsis
              style={{ margin: 0, flex: 1, minWidth: 0, textAlign: 'center' }}
            >
              {mobileSection ? settingsSectionMobileLabel(mobileSection) : 'Settings'}
            </Typography.Title>
            <Button
              type="text"
              icon={<CloseOutlined />}
              aria-label="Close settings"
              onClick={onClose}
              style={{ minWidth: MOBILE_TOUCH_TARGET, minHeight: MOBILE_TOUCH_TARGET }}
            />
          </Flex>
          <Content
            style={{
              padding: mobileSection
                ? `${token.paddingLG}px ${token.paddingMD}px ${token.paddingXL}px`
                : 0,
              overflowY: 'auto',
              overflowX: 'hidden',
              minWidth: 0,
              width: '100%',
              maxWidth: '100%',
              boxSizing: 'border-box',
            }}
          >
            {mobileSection ? (
              <div style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}>{renderContent()}</div>
            ) : (
              <Flex
                vertical
                gap={token.marginLG}
                style={{
                  padding: `${token.paddingMD}px ${token.padding}px ${token.paddingXL}px`,
                }}
              >
                {/* Account identity summary (read-only). */}
                {currentUser && (
                  <div>
                    <Typography.Text
                      type="secondary"
                      style={{
                        fontSize: token.fontSizeSM,
                        paddingInlineStart: token.paddingXS,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                      }}
                    >
                      Account
                    </Typography.Text>
                    <div style={settingsGroupCardStyle}>
                      <Flex align="center" gap={token.margin} style={{ padding: token.padding }}>
                        <UserOutlined
                          style={{ fontSize: token.fontSizeLG, color: token.colorTextSecondary }}
                        />
                        <Flex vertical style={{ flex: 1, minWidth: 0 }}>
                          <Typography.Text strong ellipsis>
                            {currentUser.name || currentUser.email || 'You'}
                          </Typography.Text>
                          <Typography.Text
                            type="secondary"
                            ellipsis
                            style={{ fontSize: token.fontSizeSM }}
                          >
                            {[currentUser.email, currentUser.role].filter(Boolean).join(' · ')}
                          </Typography.Text>
                        </Flex>
                      </Flex>
                    </div>
                  </div>
                )}

                {settingsNav.map((group) => (
                  <div key={group.key}>
                    <Typography.Text
                      type="secondary"
                      style={{
                        fontSize: token.fontSizeSM,
                        paddingInlineStart: token.paddingXS,
                        textTransform: 'uppercase',
                        letterSpacing: 0.4,
                      }}
                    >
                      {group.mobileTitle ?? group.title}
                    </Typography.Text>
                    <div style={settingsGroupCardStyle}>
                      {group.rows.map((row, index) => (
                        <button
                          key={row.section}
                          type="button"
                          aria-label={row.mobileLabel ?? row.label}
                          onClick={() => drillIntoSection(row.section)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: token.margin,
                            width: '100%',
                            minHeight: MOBILE_TOUCH_TARGET,
                            padding: `${token.paddingXS}px ${token.padding}px`,
                            cursor: 'pointer',
                            background: 'none',
                            border: 'none',
                            borderTop:
                              index === 0 ? undefined : `1px solid ${token.colorBorderSecondary}`,
                            font: 'inherit',
                            color: 'inherit',
                            textAlign: 'left',
                          }}
                        >
                          <span
                            style={{ fontSize: token.fontSizeLG, color: token.colorTextSecondary }}
                          >
                            {row.icon}
                          </span>
                          <Typography.Text ellipsis style={{ flex: 1, minWidth: 0 }}>
                            {row.mobileLabel ?? row.label}
                          </Typography.Text>
                          {row.count !== undefined && (
                            <Typography.Text
                              type="secondary"
                              style={{ fontSize: token.fontSizeSM }}
                            >
                              {row.count}
                            </Typography.Text>
                          )}
                          <RightOutlined
                            aria-hidden
                            style={{ color: token.colorTextTertiary, fontSize: token.fontSizeSM }}
                          />
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </Flex>
            )}
          </Content>
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
          onOpenSettings={() => {
            handleBranchModalClose();
            onTabChange?.('repos');
          }}
          presentation="bottom-sheet"
        />
      </Drawer>
    );
  }

  return (
    <Modal
      title={null}
      open={open}
      onCancel={onClose}
      footer={null}
      closable
      width={compact ? 'calc(100vw - 16px)' : 1200}
      style={{ top: compact ? 8 : 40 }}
      styles={{
        wrapper: {
          padding: 0,
          overflow: 'hidden',
        },
        container: {
          padding: 0,
          borderRadius: compact ? token.borderRadiusSM : token.borderRadiusLG,
          overflow: 'hidden',
        },
        header: {
          display: 'none',
        },
        body: {
          padding: 0,
          height: compact ? 'calc(100dvh - 16px)' : 'calc(100vh - 200px)',
          minHeight: compact ? 0 : 500,
          maxHeight: compact ? 'none' : 800,
        },
      }}
      closeIcon={<CloseOutlined />}
    >
      <Layout
        style={{
          height: '100%',
          background: token.colorBgContainer,
          flexDirection: compact ? 'column' : 'row',
        }}
      >
        <Sider
          width={compact ? '100%' : 240}
          style={{
            background: token.colorBgElevated,
            borderRight: compact ? 0 : `1px solid ${token.colorBorderSecondary}`,
            borderBottom: compact ? `1px solid ${token.colorBorderSecondary}` : 0,
            overflow: 'auto',
            maxHeight: compact ? 230 : undefined,
            flex: compact ? '0 0 auto' : undefined,
            padding: compact ? '12px 0' : '20px 0',
          }}
        >
          <div
            style={{
              padding: compact ? '0 12px 10px' : '0 24px 16px',
              fontWeight: 600,
              fontSize: compact ? 15 : 18,
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
        <Content
          style={{ padding: compact ? '40px 12px 20px' : '40px 32px 32px', overflow: 'auto' }}
        >
          {renderContent()}
        </Content>
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
        onOpenSettings={() => {
          handleBranchModalClose();
          onTabChange?.('repos');
        }}
      />
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
