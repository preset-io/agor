import { AppstoreOutlined, BranchesOutlined, PlusOutlined, RobotOutlined } from '@ant-design/icons';
import type { MenuProps } from 'antd';
import { Button, Dropdown, Layout, Modal, Segmented, Select, Typography, theme } from 'antd';
import type React from 'react';
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_BACKGROUNDS } from '../../constants/ui';
import { agorStore, shallow, useAgorStore, useStoreWithEqualityFn } from '../../store/agorStore';
import { selectBoardById } from '../../store/selectors';
import { isDarkTheme } from '../../utils/theme';
import { HomeActivitySection } from './HomeActivitySection';
import { HomeBoardsSection } from './HomeBoardsSection';
import { HomeKnowledgeSection } from './HomeKnowledgeSection';
import { HomeSessionsSection } from './HomeSessionsSection';
import { HomeStatsBar } from './HomeStatsBar';
import { glassCardStyle } from './homeStyles';
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

const NEW_MENU_ITEMS: MenuProps['items'] = [
  { key: 'assistant', label: 'New assistant', icon: <RobotOutlined /> },
  { key: 'branch', label: 'New branch', icon: <BranchesOutlined /> },
  { key: 'board', label: 'New board', icon: <AppstoreOutlined /> },
];

/**
 * Gate around OnboardingCard that owns the onboarding-progress subscription,
 * so its per-notification cost (including a session scan for `hasSessions`)
 * exists ONLY while the card can appear. HomePage unmounts this once the card
 * is dismissed — the common case for established users — leaving the page
 * with zero onboarding subscription cost; when every step is done it renders
 * nothing while parked on the (rarely notified) shallow-equal booleans.
 */
const HomeOnboarding: React.FC<{
  currentUserId?: string;
  onNewSession: () => void;
  onOpenCreateDialog: HomePageProps['onOpenCreateDialog'];
  onOpenSettings: HomePageProps['onOpenSettings'];
  onDismiss: () => void;
}> = ({ currentUserId, onNewSession, onOpenCreateDialog, onOpenSettings, onDismiss }) => {
  // Booleans with shallow equality: entity patches only re-render this gate
  // when a step actually flips (e.g. first repo connected). `sessionById`
  // keeps archived sessions around for deep links, so `hasSessions` must
  // filter !archived (and scope to the current user when known); `.some`
  // exits the scan at the first match.
  const { hasBoards, hasRepos, hasMcp, hasTeammates, hasSessions } = useStoreWithEqualityFn(
    agorStore,
    (state) => ({
      hasBoards: state.boardById.size > 0,
      hasRepos: state.repoById.size > 0,
      hasMcp: state.mcpServerById.size > 0,
      hasTeammates: state.userById.size > 1,
      hasSessions: Array.from(state.sessionById.values()).some(
        (s) => !s.archived && (!currentUserId || s.created_by === currentUserId)
      ),
    }),
    shallow
  );

  const steps = useMemo(() => {
    return [
      {
        id: 'repo',
        label: 'Connect a repository',
        done: hasRepos,
        cta: 'Connect →',
        onClick: () => onOpenSettings('repos'),
      },
      {
        id: 'board',
        label: 'Create your first board',
        done: hasBoards,
        cta: 'Create →',
        onClick: () => onOpenCreateDialog('board'),
      },
      {
        id: 'session',
        label: 'Launch an AI session',
        done: hasSessions,
        cta: 'Start →',
        onClick: onNewSession,
      },
      {
        id: 'mcp',
        label: 'Configure MCP tools',
        done: hasMcp,
        cta: 'Set up →',
        onClick: () => onOpenSettings('mcp'),
      },
      {
        id: 'invite',
        label: 'Invite a teammate',
        done: hasTeammates,
        cta: 'Invite →',
        onClick: () => onOpenSettings('users'),
      },
    ];
  }, [
    hasBoards,
    hasRepos,
    hasMcp,
    hasTeammates,
    hasSessions,
    onOpenCreateDialog,
    onOpenSettings,
    onNewSession,
  ]);

  if (steps.every((s) => s.done)) return null;

  return <OnboardingCard steps={steps} onDismiss={onDismiss} />;
};

export const HomePage = memo(function HomePage(props: HomePageProps) {
  const { token } = theme.useToken();
  const homeBackground = DEFAULT_BACKGROUNDS[isDarkTheme(token) ? 'dark' : 'light'];

  // HomePage deliberately subscribes to NOTHING session-shaped: sections that
  // display session data subscribe themselves, so a streaming session patch
  // wakes only those sections — never this whole page. Boards are the one
  // whole-map subscription left (board options + default board for the create
  // modal); board patches are rare.
  const boardById = useAgorStore(selectBoardById);

  const [onboardingHidden, setOnboardingHidden] = useState(
    () => localStorage.getItem(ONBOARDING_HIDDEN_KEY) === 'true'
  );

  const currentUserName = useAgorStore((s) =>
    props.currentUserId ? s.userById.get(props.currentUserId)?.name : undefined
  );
  const username = currentUserName || 'there';

  // Resizable sidebar
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    try {
      const stored = Number(localStorage.getItem(SIDEBAR_STORAGE_KEY));
      if (!Number.isFinite(stored) || stored <= 0) return SIDEBAR_DEFAULT;
      const maxW =
        typeof window !== 'undefined'
          ? window.innerWidth * SIDEBAR_MAX_RATIO
          : Number.POSITIVE_INFINITY;
      return Math.min(Math.max(SIDEBAR_MIN, stored), Math.max(SIDEBAR_MIN, maxW));
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
  const dragCleanupRef = useRef<(() => void) | null>(null);
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
    function teardown() {
      isDragging.current = false;
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      dragCleanupRef.current = null;
    }
    function onUp() {
      setSidebarWidth((w) => {
        try {
          localStorage.setItem(SIDEBAR_STORAGE_KEY, String(Math.round(w)));
        } catch {}
        return w;
      });
      teardown();
    }
    dragCleanupRef.current = teardown;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }, []);

  // Tear down an in-progress drag if the page unmounts mid-drag.
  useEffect(() => () => dragCleanupRef.current?.(), []);

  const defaultBoardId = useMemo(() => {
    const firstRecent = (props.recentBoardIds ?? []).find(
      (id) => boardById.get(id)?.archived === false
    );
    if (firstRecent) return firstRecent;
    for (const board of boardById.values()) {
      if (!board.archived) return board.board_id;
    }
    return undefined;
  }, [boardById, props.recentBoardIds]);

  const boardOptions = useMemo(
    () =>
      Array.from(boardById.values())
        .filter((b) => !b.archived)
        .map((b) => ({ value: b.board_id, label: `${b.icon || '📋'} ${b.name}` })),
    [boardById]
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [selectedBoardId, setSelectedBoardId] = useState<string | undefined>();
  const [createType, setCreateType] = useState<'assistant' | 'branch'>('assistant');

  const handleNewSession = useCallback(
    (defaultType: 'assistant' | 'branch' = 'assistant') => {
      setCreateType(defaultType);
      setSelectedBoardId(defaultBoardId);
      setCreateOpen(true);
    },
    [defaultBoardId]
  );

  const handleConfirmCreate = useCallback(() => {
    setCreateOpen(false);
    props.onOpenCreateDialog(createType, selectedBoardId);
  }, [props.onOpenCreateDialog, createType, selectedBoardId]);

  return (
    <>
      <div style={{ height: '100%', overflow: 'hidden', background: homeBackground }}>
        <Layout hasSider style={{ height: '100%', background: 'transparent' }}>
          <Content
            style={{
              overflowY: 'auto',
              display: 'flex',
              flexDirection: 'column',
              padding: 'clamp(16px, 3vw, 28px) clamp(16px, 3vw, 32px) 80px',
            }}
          >
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                minHeight: 0,
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
                    Here's an overview of your workspace.
                  </Text>
                </div>
                <Dropdown
                  menu={{
                    items: NEW_MENU_ITEMS,
                    onClick: ({ key }) => {
                      if (key === 'assistant' || key === 'branch') {
                        handleNewSession(key);
                      } else {
                        props.onOpenCreateDialog(key as 'board');
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

              {/* Get started onboarding card — gate unmounted once dismissed */}
              {!onboardingHidden && (
                <HomeOnboarding
                  currentUserId={props.currentUserId}
                  onNewSession={handleNewSession}
                  onOpenCreateDialog={props.onOpenCreateDialog}
                  onOpenSettings={props.onOpenSettings}
                  onDismiss={() => {
                    localStorage.setItem(ONBOARDING_HIDDEN_KEY, 'true');
                    setOnboardingHidden(true);
                  }}
                />
              )}

              {/* Jump back in — awaiting sessions (renders nothing when none) */}
              <JumpBackInSection
                currentUserId={props.currentUserId}
                onSessionClick={props.onSessionClick}
              />

              {/* Workspace stats */}
              <HomeStatsBar currentUserId={props.currentUserId} />

              {/* My Sessions — flex: 1 fills remaining viewport height */}
              <HomeSessionsSection
                currentUserId={props.currentUserId}
                onSessionClick={props.onSessionClick}
              />

              {/* Boards grid */}
              <div style={{ marginTop: 24 }}>
                <HomeBoardsSection
                  recentBoardIds={props.recentBoardIds}
                  onBoardClick={props.onBoardClick}
                  onOpenCreateDialog={props.onOpenCreateDialog}
                />
              </div>
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
                ...glassCardStyle(token, 0.5),
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
        title={createType === 'branch' ? 'New branch' : 'New assistant'}
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        width={420}
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
                    props.onOpenCreateDialog('board');
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
                  {createType === 'assistant' ? 'Start assistant' : 'Create branch'}
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
          <div style={{ padding: '8px 0 4px', display: 'flex', flexDirection: 'column', gap: 14 }}>
            <Segmented
              value={createType}
              onChange={(v) => setCreateType(v as 'assistant' | 'branch')}
              block
              options={[
                { value: 'assistant', label: 'AI assistant', icon: <RobotOutlined /> },
                { value: 'branch', label: 'Branch / Worktree', icon: <BranchesOutlined /> },
              ]}
            />
            <div>
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
          </div>
        )}
      </Modal>
    </>
  );
});

export default HomePage;
