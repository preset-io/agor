import type { SessionStatus } from '@agor-live/client';
import { AppstoreOutlined, BranchesOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, Layout, Modal, Select, Typography, theme } from 'antd';
import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { isDarkTheme } from '../../utils/theme';
import { HomeActivitySection } from './HomeActivitySection';
import { HomeBoardsSection } from './HomeBoardsSection';
import { HomeKnowledgeSection } from './HomeKnowledgeSection';
import { HomeSessionsSection } from './HomeSessionsSection';
import { HomeStatsBar } from './HomeStatsBar';
import { JumpBackInSection } from './JumpBackInSection';
import { OnboardingCard } from './OnboardingCard';
import type { HomePageProps } from './types';

const { Content } = Layout;
const { Text, Title } = Typography;

const ONBOARDING_HIDDEN_KEY = 'agor:onboarding-card-hidden';
const SIDEBAR_STORAGE_KEY = 'agor:homepage-sidebar-width';
const SIDEBAR_DEFAULT = 340;
const SIDEBAR_MIN = 240;
const SIDEBAR_MAX_RATIO = 0.5;

const AWAITING_STATUSES = new Set<SessionStatus>(['awaiting_permission', 'awaiting_input']);

const NEW_MENU_ITEMS: MenuProps['items'] = [
  { key: 'assistant', label: 'New assistant', icon: <RobotOutlined /> },
  { key: 'branch', label: 'New branch', icon: <BranchesOutlined /> },
  { key: 'board', label: 'New board', icon: <AppstoreOutlined /> },
];

export const HomePage: React.FC<HomePageProps> = (props) => {
  const { token } = theme.useToken();
  const homeBackground = DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'];

  const [onboardingHidden, setOnboardingHidden] = useState(
    () => localStorage.getItem(ONBOARDING_HIDDEN_KEY) === 'true'
  );

  const currentUser = props.currentUserId ? props.userById.get(props.currentUserId) : null;
  const username = currentUser?.name || currentUser?.email?.split('@')[0] || 'there';

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const v = localStorage.getItem(SIDEBAR_STORAGE_KEY);
      return v ? Math.max(SIDEBAR_MIN, Number(v)) : SIDEBAR_DEFAULT;
    } catch {
      return SIDEBAR_DEFAULT;
    }
  });
  const [sidebarVisible, setSidebarVisible] = useState(
    () => typeof window !== 'undefined' && window.innerWidth >= 992
  );
  const [dragHandleHovered, setDragHandleHovered] = useState(false);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);
  const sidebarWidthRef = useRef(sidebarWidth);
  sidebarWidthRef.current = sidebarWidth;

  useEffect(() => {
    const onResize = () => setSidebarVisible(window.innerWidth >= 992);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    dragStartX.current = e.clientX;
    dragStartW.current = sidebarWidthRef.current;

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current) return;
      const maxW = window.innerWidth * SIDEBAR_MAX_RATIO;
      const newW = Math.max(
        SIDEBAR_MIN,
        Math.min(maxW, dragStartW.current - (ev.clientX - dragStartX.current))
      );
      setSidebarWidth(newW);
    };
    const onUp = () => {
      isDragging.current = false;
      setSidebarWidth((w) => {
        try {
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(w)));
        } catch {}
        return w;
      });
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  const waitingSessions = useMemo(
    () =>
      Array.from(props.sessionById.values()).filter(
        (s) =>
          !s.archived &&
          AWAITING_STATUSES.has(s.status) &&
          (!props.currentUserId || s.created_by === props.currentUserId)
      ),
    [props.sessionById, props.currentUserId]
  );

  const defaultBoardId = useMemo(() => {
    const firstRecent = (props.recentBoardIds ?? []).find((id) => props.boardById.has(id));
    if (firstRecent) return firstRecent;
    return props.boardById.values().next().value?.board_id;
  }, [props.boardById, props.recentBoardIds]);

  const boardOptions = useMemo(
    () =>
      Array.from(props.boardById.values())
        .filter((b) => !b.archived)
        .map((b) => ({ value: b.board_id, label: `${b.icon || '📋'} ${b.name}` })),
    [props.boardById]
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string | undefined>();

  const handleNewSession = useCallback(() => {
    setSelectedBoardId(defaultBoardId);
    setCreateOpen(true);
  }, [defaultBoardId]);

  const handleConfirmCreate = useCallback(() => {
    setCreateOpen(false);
    props.onOpenCreateDialog?.('assistant', selectedBoardId);
  }, [props.onOpenCreateDialog, selectedBoardId]);

  const onboardingSteps = useMemo(() => {
    const hasBoards = props.boardById.size > 0;
    const hasRepos = props.repoById.size > 0;
    const hasMcp = (props.mcpServerById?.size ?? 0) > 0;
    const hasTeammates = props.userById.size > 1;
    const hasSessions = Array.from(props.sessionById.values()).some(
      (s) => !s.archived && (!props.currentUserId || s.created_by === props.currentUserId)
    );
    return [
      {
        id: 'repo',
        label: 'Connect a repository',
        done: hasRepos,
        cta: 'Connect →',
        onClick: () => props.onOpenSettings?.('repos'),
      },
      {
        id: 'board',
        label: 'Create your first board',
        done: hasBoards,
        cta: 'Create →',
        onClick: () => props.onOpenCreateDialog?.('board'),
      },
      {
        id: 'session',
        label: 'Launch an AI session',
        done: hasSessions,
        cta: 'Start →',
        onClick: handleNewSession,
      },
      {
        id: 'mcp',
        label: 'Configure MCP tools',
        done: hasMcp,
        cta: 'Set up →',
        onClick: () => props.onOpenSettings?.('mcp'),
      },
      {
        id: 'invite',
        label: 'Invite a teammate',
        done: hasTeammates,
        cta: 'Invite →',
        onClick: () => props.onOpenSettings?.('users'),
      },
    ];
  }, [
    props.boardById,
    props.sessionById,
    props.repoById,
    props.userById,
    props.mcpServerById,
    props.currentUserId,
    props.onOpenCreateDialog,
    props.onOpenSettings,
    handleNewSession,
  ]);

  const showOnboardingCard = !onboardingHidden && onboardingSteps.some((s) => !s.done);

  return (
    <>
      <div style={{ height: '100%', overflow: 'hidden', background: homeBackground }}>
        <Layout hasSider style={{ height: '100%', background: 'transparent' }}>
          <Content
            style={{
              overflowY: 'auto',
              padding: 'clamp(16px, 3vw, 28px) clamp(16px, 3vw, 32px) 80px',
            }}
          >
            {/* Greeting */}
            <header
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                justifyContent: 'space-between',
                gap: 16,
                marginBottom: 24,
              }}
            >
              <div>
                <Title level={5} style={{ margin: 0, fontWeight: 700 }}>
                  Hi, {username}! 👋
                </Title>
                <Text type="secondary" style={{ fontSize: 14 }}>
                  Here's what's happening across your boards.
                </Text>
              </div>
              <Dropdown
                menu={{
                  items: NEW_MENU_ITEMS,
                  onClick: ({ key }) => {
                    if (key === 'assistant') {
                      handleNewSession();
                    } else {
                      props.onOpenCreateDialog?.(key as 'branch' | 'board');
                    }
                  },
                }}
                trigger={['click']}
              >
                <Button type="primary" icon={<PlusOutlined />}>
                  New
                </Button>
              </Dropdown>
            </header>

            {/* Get started onboarding card */}
            {showOnboardingCard && (
              <OnboardingCard
                steps={onboardingSteps}
                onDismiss={() => {
                  localStorage.setItem(ONBOARDING_HIDDEN_KEY, 'true');
                  setOnboardingHidden(true);
                }}
              />
            )}

            {/* Jump back in — awaiting sessions */}
            {waitingSessions.length > 0 && (
              <JumpBackInSection sessions={waitingSessions} onSessionClick={props.onSessionClick} />
            )}

            {/* Workspace stats */}
            <HomeStatsBar
              sessionById={props.sessionById}
              currentUserId={props.currentUserId}
              onSessionClick={props.onSessionClick}
              onOpenCreateDialog={props.onOpenCreateDialog}
              onOpenSettings={props.onOpenSettings}
            />

            {/* My Sessions */}
            <HomeSessionsSection
              sessionById={props.sessionById}
              branchById={props.branchById}
              boardById={props.boardById}
              currentUserId={props.currentUserId}
              onSessionClick={props.onSessionClick}
            />

            {/* Boards grid */}
            <div style={{ marginTop: 24 }}>
              <HomeBoardsSection
                boardById={props.boardById}
                recentBoardIds={props.recentBoardIds}
                branchById={props.branchById}
                sessionsByBranch={props.sessionsByBranch}
                onBoardClick={props.onBoardClick}
                onOpenCreateDialog={props.onOpenCreateDialog}
              />
            </div>
          </Content>

          {/* Resizable right sidebar — hidden below 992px */}
          {sidebarVisible && (
            <aside
              style={{
                width: sidebarWidth,
                flexShrink: 0,
                position: 'relative',
                borderLeft: `1px solid ${token.colorBorderSecondary}`,
                background: token.colorBgContainer,
                overflow: 'hidden',
                display: 'flex',
                flexDirection: 'column',
              }}
            >
              {/* Drag handle — biome-ignore lint/a11y/useSemanticElements: needs position:absolute full-height layout; <hr> can't serve as an interactive resize slider */}
              {/* biome-ignore lint/a11y/useSemanticElements: interactive resize handle */}
              <div
                role="separator"
                aria-orientation="vertical"
                aria-label="Resize sidebar"
                aria-valuenow={Math.round(sidebarWidth)}
                aria-valuemin={SIDEBAR_MIN}
                aria-valuemax={Math.round(
                  typeof window !== 'undefined'
                    ? window.innerWidth * SIDEBAR_MAX_RATIO
                    : SIDEBAR_DEFAULT
                )}
                tabIndex={0}
                onMouseDown={handleDragStart}
                onMouseEnter={() => setDragHandleHovered(true)}
                onMouseLeave={() => setDragHandleHovered(false)}
                onKeyDown={(e) => {
                  const delta = e.key === 'ArrowLeft' ? 8 : e.key === 'ArrowRight' ? -8 : 0;
                  if (delta) {
                    e.preventDefault();
                    setSidebarWidth((w) => {
                      const maxW =
                        typeof window !== 'undefined'
                          ? window.innerWidth * SIDEBAR_MAX_RATIO
                          : SIDEBAR_DEFAULT;
                      const newW = Math.max(SIDEBAR_MIN, Math.min(maxW, w + delta));
                      try {
                        localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(newW)));
                      } catch {}
                      return newW;
                    });
                  }
                }}
                title="Drag or use arrow keys to resize"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 4,
                  cursor: 'col-resize',
                  zIndex: 10,
                  background: dragHandleHovered ? token.colorPrimary : 'transparent',
                  transition: 'background 0.15s',
                }}
              />
              <div
                style={{
                  flex: 1,
                  minHeight: 0,
                  display: 'flex',
                  flexDirection: 'column',
                  overflow: 'hidden',
                  padding: '16px 12px 16px 16px',
                  gap: 32,
                }}
              >
                <HomeActivitySection
                  branchById={props.branchById}
                  boardById={props.boardById}
                  sessionById={props.sessionById}
                  userById={props.userById}
                  onBoardClick={props.onBoardClick}
                  onBranchClick={props.onBranchClick}
                  onSessionClick={props.onSessionClick}
                />
                <HomeKnowledgeSection client={props.client} connected={props.connected} />
              </div>
            </aside>
          )}
        </Layout>
      </div>

      <Modal
        title="New assistant"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        width={400}
        footer={
          boardOptions.length === 0
            ? [
                <Button key="cancel" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>,
                <Button
                  key="create"
                  type="primary"
                  onClick={() => {
                    setCreateOpen(false);
                    props.onOpenCreateDialog?.('board');
                  }}
                >
                  Create a board first
                </Button>,
              ]
            : [
                <Button key="cancel" onClick={() => setCreateOpen(false)}>
                  Cancel
                </Button>,
                <Button
                  key="start"
                  type="primary"
                  disabled={!selectedBoardId}
                  onClick={handleConfirmCreate}
                >
                  Start assistant
                </Button>,
              ]
        }
      >
        {boardOptions.length === 0 ? (
          <div style={{ padding: '8px 0 4px' }}>
            <Typography.Text type="secondary" style={{ display: 'block', fontSize: 13 }}>
              You don't have any boards yet. Create one first to organise your work.
            </Typography.Text>
          </div>
        ) : (
          <div style={{ padding: '8px 0 4px' }}>
            <Typography.Text style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
              Which board?
            </Typography.Text>
            <Select
              value={selectedBoardId}
              onChange={setSelectedBoardId}
              options={boardOptions}
              placeholder="Select a board"
              style={{ width: '100%' }}
            />
          </div>
        )}
      </Modal>
    </>
  );
};

export default HomePage;
