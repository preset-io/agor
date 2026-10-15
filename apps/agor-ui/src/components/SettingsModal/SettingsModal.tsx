import type {
  AgorClient,
  Artifact,
  Board,
  Branch,
  BranchArchiveOrDeleteOptions,
  CreateLocalRepoRequest,
  CreateRepoRequest,
  CreateUserInput,
  GatewayChannelCreateData,
  GatewayChannelPatchData,
  Repo,
  UpdateUserInput,
  User,
} from '@agor-live/client';
import { hasMinimumRole, ROLES } from '@agor-live/client';
import { ArrowLeftOutlined, CloseOutlined, RightOutlined, UserOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Drawer, Flex, Grid, Layout, Menu, Modal, Tag, Typography, theme } from 'antd';
import { useCallback, useMemo, useState } from 'react';
import { useAuthenticatedAuthorityScope } from '@/hooks/useAuthorityOperationGuard';
import type { BranchStorageConfig } from '@/utils/branchStorage';
import { mapToArray } from '@/utils/mapHelpers';
import { useBranchSessions } from '../../hooks/useBranchSessions';
import { reducedMotionSurface, usePrefersReducedMotion } from '../../hooks/usePrefersReducedMotion';
import { SETTINGS_SECTIONS, type SettingsSection } from '../../hooks/useSettingsRoute';
import { useAgorStore } from '../../store/agorStore';
import {
  selectArtifactById,
  selectBoardById,
  selectBoardObjectById,
  selectBranchById,
  selectCardTypeById,
  selectGatewayChannelById,
  selectMcpServerById,
  selectRepoById,
  selectUserById,
} from '../../store/selectors';
import { MOBILE_TOUCH_TARGET } from '../../utils/deviceDetection';
import { BranchModal } from '../BranchModal';
import type { BranchUpdate } from '../BranchModal/tabs/GeneralTab';
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
import { SettingsDrillProvider, useDrillShell } from './SettingsDrill';
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
  /** Requested section; omitted (or unknown) opens the first section the caller can see. */
  activeTab?: string;
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
  onArchiveOrDeleteBranch?: (
    branchId: string,
    options: BranchArchiveOrDeleteOptions
  ) => void | Promise<void>;
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
    shouldApply?: () => boolean,
    options?: { errorShownInline?: boolean }
  ) => void | Promise<void>;
  onDeleteUser?: (userId: string, shouldApply?: () => boolean) => void | Promise<void>;
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
  /** Opens the teammate create flow (main's TeammatesTable triggers it directly). */
  onCreateTeammate?: () => void;
  branchStorageConfig?: BranchStorageConfig;
}

const SettingsModalContent: React.FC<SettingsModalProps> = ({
  open,
  onClose,
  client,
  currentUser,
  activeTab: requestedTab,
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
  const userById = useAgorStore(selectUserById);
  const mcpServerById = useAgorStore(selectMcpServerById);
  const cardTypeById = useAgorStore(selectCardTypeById);
  const gatewayChannelById = useAgorStore(selectGatewayChannelById);
  const artifactById = useAgorStore(selectArtifactById);
  const boardObjects = useMemo(() => mapToArray(boardObjectById), [boardObjectById]);
  const settingsAuthority = useAuthenticatedAuthorityScope(
    client,
    currentUser ? `${currentUser.user_id}:${currentUser.role}` : null
  );

  const { token } = theme.useToken();
  // Responsive shell: below AntD's `md` breakpoint the Modal + Sider become a
  // full-screen Drawer with a grouped section index that drills into the same
  // section content (and the same in-place drill-in editors).
  const screens = Grid.useBreakpoint();
  const compact = !screens.md;
  const reducedMotion = usePrefersReducedMotion();
  const settingsSectionKeys = useMemo(() => new Set<string>(SETTINGS_SECTIONS), []);

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

  // One nav model feeds the desktop sidebar and the mobile index, so they cannot drift apart
  const settingsNav = useMemo(
    () =>
      buildSettingsNav({
        isAdmin,
        canSeeSection,
        counts: {
          boards: boardById.size,
          repos: repoById.size,
          // No branch or card count: the store holds only the loaded scopes' rows.
          artifacts: artifactById.size,
          gateway: gatewayChannelById.size,
          users: userById.size,
        },
      }),
    [
      canSeeSection,
      isAdmin,
      boardById.size,
      repoById.size,
      artifactById.size,
      gatewayChannelById.size,
      userById.size,
    ]
  );

  // No (or an unknown) requested section opens the first one this role can see.
  const activeTab =
    requestedTab && settingsSectionKeys.has(requestedTab)
      ? requestedTab
      : (settingsNav[0]?.rows[0]?.section ?? 'about');

  // Drill-in navigation: the Content pane swaps between a section's list view
  // and its detail/edit view in place, instead of stacking a second Modal.
  const shell = useDrillShell(activeTab as SettingsSection);
  const { drill, openDrill, closeDrill, confirmLeaveIfDirty } = shell;

  // Branches and Teammates edit the same entity (a branch) via the shared
  // BranchModal, rendered in-place (embedded) as the section's drill-in instead
  // of a stacked modal. The store holds only the loaded scopes' branches, so the
  // clicked row is snapshotted; the live store copy wins when it is loaded.
  const [branchSnapshot, setBranchSnapshot] = useState<Branch | null>(null);
  const branchDrill =
    drill?.mode === 'edit' &&
    (activeTab === 'branches' || activeTab === 'teammates') &&
    drill.recordId
      ? (branchById.get(drill.recordId) ??
        (branchSnapshot?.branch_id === drill.recordId ? branchSnapshot : null))
      : null;
  const openBranchDrill = useCallback(
    (branch: Branch) => {
      setBranchSnapshot(branch);
      openDrill({ mode: 'edit', recordId: branch.branch_id });
    },
    [openDrill]
  );
  // The store holds only the loaded scopes' sessions: each opening reads the branch's.
  const branchSessions = useBranchSessions(client, branchDrill?.branch_id ?? null);

  const handleArchiveOrDeleteBranchFromDrill = useCallback(
    async (branchId: string, options: BranchArchiveOrDeleteOptions) => {
      await onArchiveOrDeleteBranch?.(branchId, options);
      closeDrill();
    },
    [onArchiveOrDeleteBranch, closeDrill]
  );

  const handleNavClick = useCallback(
    (key: string) => {
      // The MCP Marketplace is intentionally NOT reachable from Settings — it
      // lives only on the global navbar. No nav row or signpost here.
      if (!settingsSectionKeys.has(key)) return;
      if (key === activeTab) return;
      confirmLeaveIfDirty(() => {
        closeDrill();
        onTabChange?.(key as SettingsSection);
      });
    },
    [activeTab, closeDrill, confirmLeaveIfDirty, onTabChange, settingsSectionKeys]
  );

  const handleModalClose = useCallback(
    () => confirmLeaveIfDirty(onClose),
    [confirmLeaveIfDirty, onClose]
  );

  // Menu items for left sidebar navigation. People leads (access first), then
  // Resources, Cards, Integrations and System.
  const menuItems: MenuProps['items'] = useMemo(
    () =>
      settingsNav.map((group) => ({
        key: group.key,
        label: group.badge ? (
          <span>
            {group.title}{' '}
            <Tag
              color={group.badge === 'Beta' ? 'warning' : undefined}
              style={{ marginInlineStart: token.marginXXS, fontSize: token.fontSizeSM }}
            >
              {group.badge}
            </Tag>
          </span>
        ) : (
          group.title
        ),
        type: 'group' as const,
        children: group.rows.map((row) => ({
          key: row.section,
          icon: row.icon,
          label: row.label,
        })),
      })),
    [settingsNav, token]
  );

  // Mobile drill state: null = the grouped index. A deep-link opener (e.g. the
  // "Create teammate" flow) seeds straight into its section; the generic mobile
  // entry ('boards', from the More sheet) opens on the index. Desktop ignores this.
  const [mobileSection, setMobileSection] = useState<SettingsSection | null>(() =>
    requestedTab &&
    requestedTab !== 'boards' &&
    (SETTINGS_SECTIONS as readonly string[]).includes(requestedTab)
      ? (requestedTab as SettingsSection)
      : null
  );

  const drillIntoSection = useCallback(
    (section: SettingsSection) => {
      setMobileSection(section);
      if (section !== activeTab) onTabChange?.(section);
    },
    [activeTab, onTabChange]
  );

  // Mobile header Back: leaves an open drill-in (guarded) and the section
  // together, returning to the index.
  const handleMobileBack = useCallback(
    () =>
      confirmLeaveIfDirty(() => {
        closeDrill();
        setMobileSection(null);
      }),
    [closeDrill, confirmLeaveIfDirty]
  );

  // Shared iOS-style grouped-list card wrapper for the mobile index.
  const settingsGroupCardStyle: React.CSSProperties = {
    marginTop: token.marginXS,
    border: `1px solid ${token.colorBorderSecondary}`,
    borderRadius: token.borderRadiusLG,
    background: token.colorBgContainer,
    overflow: 'hidden',
  };

  // The shared BranchModal, rendered in-place as the drill-in for both the
  // Branches and Teammates sections (embedded → no stacked modal).
  const branchEditor = branchDrill ? (
    <BranchModal
      embedded
      open
      onClose={closeDrill}
      branch={branchDrill}
      repo={repoById.get(branchDrill.repo_id) ?? null}
      sessions={branchSessions}
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
            canConfigureCleanup={isAdmin}
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
          branchEditor ?? (
            <BranchesTable
              currentUser={currentUser}
              client={client}
              branchById={branchById}
              repoById={repoById}
              boardById={boardById}
              onArchiveOrDelete={onArchiveOrDeleteBranch}
              onUnarchive={onUnarchiveBranch}
              onCreate={onCreateBranch}
              onRowClick={openBranchDrill}
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
              userById={userById}
              onArchiveOrDelete={onArchiveOrDeleteBranch}
              onRowClick={openBranchDrill}
              onCreateTeammate={onCreateTeammate}
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
            cardTypeById={cardTypeById}
            boardById={boardById}
            // The resolved user's role: the panel's dataset reads (with or
            // without placements) start once, at open.
            canReadPlacements={hasMinimumRole(currentUser?.role, ROLES.MEMBER)}
            onClose={onClose}
          />
        );
      case 'artifacts':
        return (
          <ArtifactsTable
            client={client}
            artifactById={artifactById}
            branchById={branchById}
            boardById={boardById}
            userById={userById}
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

  const drillProvider = (children: React.ReactNode) => (
    <SettingsDrillProvider shell={shell}>{children}</SettingsDrillProvider>
  );

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
        onClose={handleModalClose}
        footer={shell.footer}
        styles={{ body: { padding: 0, overflow: 'hidden' } }}
      >
        {drillProvider(
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
                  onClick={handleMobileBack}
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
                {mobileSection ? settingsSectionMobileLabel(mobileSection) : 'Workspace Settings'}
              </Typography.Title>
              <Button
                type="text"
                icon={<CloseOutlined />}
                aria-label="Close settings"
                onClick={handleModalClose}
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
                <div style={{ minWidth: 0, width: '100%', maxWidth: '100%' }}>
                  {renderContent()}
                </div>
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
                        {group.badge ? ` · ${group.badge}` : ''}
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
                              style={{
                                fontSize: token.fontSizeLG,
                                color: token.colorTextSecondary,
                              }}
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
        )}
      </Drawer>
    );
  }

  return (
    <Modal
      // The header bar is hidden (styles.header) but the dialog still needs an
      // accessible name; `title` becomes rc-dialog's aria-labelledby target.
      title="Workspace Settings"
      open={open}
      onCancel={handleModalClose}
      footer={shell.footer}
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
      {drillProvider(
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
                distinct wording ("Workspace Settings" vs "User Settings") is
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
          <Content style={{ padding: '40px 32px 32px', overflow: 'auto', minWidth: 0 }}>
            {renderContent()}
          </Content>
        </Layout>
      )}
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
