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
  const [sidebarVisible, setSidebarVisible] = useState(() => window.innerWidth >= 992);
  const isDragging = useRef(false);
  const dragStartX = useRef(0);
  const dragStartW = useRef(0);

  useEffect(() => {
    const onResize = () => setSidebarVisible(window.innerWidth >= 992);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const handleDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isDragging.current = true;
      dragStartX.current = e.clientX;
      dragStartW.current = sidebarWidth;

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
    },
    [sidebarWidth]
  );

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

  const [boardPickerOpen, setBoardPickerOpen] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string | undefined>();

  const handleNewSession = useCallback(() => {
    setSelectedBoardId(defaultBoardId);
    setBoardPickerOpen(true);
  }, [defaultBoardId]);

  const handleConfirmBoard = useCallback(() => {
    setBoardPickerOpen(false);
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

  const newMenuItems: MenuProps['items'] = [
    { key: 'assistant', label: 'New session', icon: <RobotOutlined /> },
    { key: 'branch', label: 'New branch', icon: <BranchesOutlined /> },
    { key: 'board', label: 'New board', icon: <AppstoreOutlined /> },
  ];

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
                <Title level={3} style={{ margin: 0, fontWeight: 700, fontSize: 16 }}>
                  Hi, {username}! 👋
                </Title>
                <Text type="secondary" style={{ fontSize: 14 }}>
                  Here's what's happening across your boards.
                </Text>
              </div>
              <Dropdown
                menu={{
                  items: newMenuItems,
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
                <Button icon={<PlusOutlined />}>New</Button>
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
              {/* Drag handle */}
              <div
                onMouseDown={handleDragStart}
                title="Drag to resize"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: 4,
                  cursor: 'col-resize',
                  zIndex: 10,
                  background: 'transparent',
                  transition: 'background 0.15s',
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = token.colorPrimary;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLDivElement).style.background = 'transparent';
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
        title="Start a session"
        open={boardPickerOpen}
        onCancel={() => setBoardPickerOpen(false)}
        width={400}
        footer={[
          <Button key="cancel" onClick={() => setBoardPickerOpen(false)}>
            Cancel
          </Button>,
          <Button
            key="start"
            type="primary"
            disabled={!selectedBoardId}
            onClick={handleConfirmBoard}
          >
            Continue
          </Button>,
        ]}
      >
        <div style={{ padding: '8px 0 4px' }}>
          <Typography.Text style={{ display: 'block', marginBottom: 8, fontSize: 13 }}>
            Which board should this session live on?
          </Typography.Text>
          <Select
            value={selectedBoardId}
            onChange={setSelectedBoardId}
            options={boardOptions}
            placeholder="Select a board"
            style={{ width: '100%' }}
          />
        </div>
      </Modal>
    </>
  );
};

export default HomePage;
