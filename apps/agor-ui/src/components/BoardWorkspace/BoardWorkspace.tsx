import type { Board, Branch } from '@agor-live/client';
import { ApartmentOutlined, AppstoreOutlined } from '@ant-design/icons';
import { Button, Drawer, Empty, Flex, Segmented, Space, theme } from 'antd';
import { useEffect, useMemo, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { useAppNavigation } from '../../hooks/useAppNavigation';
import { useAgorStore } from '../../store/agorStore';
import {
  makeSessionsForBranchSelector,
  selectRepoById,
  selectUserById,
} from '../../store/selectors';
import {
  BoardTeammatePanel,
  type BoardTeammatePanelProps,
} from '../BoardTeammatePanel/BoardTeammatePanel';
import BranchCard from '../BranchCard';
import { BoardContentDetail, type BoardContentSelection } from './BoardContent';
import { BoardComments, BoardTreeNavigator } from './BoardTreeNavigator';
import { type BoardView, useBoardViewPreferences } from './useBoardViewPreferences';

export interface BoardWorkspaceProps {
  board: Board;
  branches: Branch[];
  actions: BoardTeammatePanelProps;
  canvas: React.ReactNode;
  conversation: React.ReactNode;
  conversationOpen: boolean;
  activeBranchId?: string | null;
  activeArtifactId?: string | null;
  /** A spatial comment click opens the shared comments inspector. */
  commentsRequest?: number;
  compact?: boolean;
  onBranchClick?: (id: string) => void;
  initialTab?: 'sessions' | 'content' | 'comments';
  initialView?: BoardView;
}

/** Alternative navigators of the SAME board. Only explicit entity actions write
 * shared state. View/tab/expansion changes are local preferences. Keep the open
 * transcript in one stable slot so switching views does not discard drafts. */
export function BoardWorkspace({
  board,
  branches,
  actions,
  canvas,
  conversation,
  conversationOpen,
  activeBranchId,
  activeArtifactId,
  commentsRequest = 0,
  compact = false,
  onBranchClick,
  initialTab,
  initialView,
}: BoardWorkspaceProps) {
  const { token } = theme.useToken();
  const [preferences, updatePreferences] = useBoardViewPreferences(
    actions.currentUserId,
    board.board_id
  );
  useEffect(() => {
    if (initialTab || initialView)
      updatePreferences({
        ...(initialTab ? { tab: initialTab } : {}),
        ...(initialView ? { view: initialView } : {}),
      });
  }, [initialTab, initialView, updatePreferences]);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [teammateOpen, setTeammateOpen] = useState(false);
  const [canvasVisited, setCanvasVisited] = useState(preferences.view === 'board');
  const [content, setContent] = useState<{ target: BoardContentSelection; route: string } | null>(
    null
  );
  const location = useLocation();
  const navigation = useAppNavigation();
  const repos = useAgorStore(selectRepoById);
  const users = useAgorStore(selectUserById);
  const branchSessions = useAgorStore(
    useMemo(() => makeSessionsForBranchSelector(activeBranchId ?? ''), [activeBranchId])
  );
  const user = actions.currentUserId ? users.get(actions.currentUserId) : undefined;
  const branch = activeBranchId ? branches.find((b) => b.branch_id === activeBranchId) : undefined;
  const artifactSelection = useMemo(() => {
    const entry = Object.entries(board.objects ?? {}).find(
      ([, o]) => o.type === 'artifact' && o.artifact_id === activeArtifactId
    );
    return entry ? { kind: 'object' as const, id: entry[0] } : null;
  }, [board.objects, activeArtifactId]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deliberate navigation clears local content selection
  useEffect(() => {
    setContent(null);
  }, [location.key]);
  useEffect(() => {
    if (preferences.view === 'board') setCanvasVisited(true);
  }, [preferences.view]);
  useEffect(() => {
    if (commentsRequest) setCommentsOpen(true);
  }, [commentsRequest]);
  const selectedContent =
    (content?.route === location.key ? content.target : null) ?? artifactSelection;
  const detailOpen = Boolean(selectedContent || branch);
  const tree = preferences.view === 'tree';
  const changeView = (view: BoardView) => updatePreferences({ view });
  const openContent = (selection: BoardContentSelection) => {
    const object = board.objects?.[selection.id];
    if (!compact && selection.kind === 'object' && object?.type === 'artifact')
      navigation.goToArtifact(object.artifact_id);
    else setContent({ target: selection, route: location.key });
  };
  return (
    <Flex
      vertical
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        background: token.colorBgLayout,
        color: token.colorText,
      }}
    >
      <Flex
        align="center"
        justify="space-between"
        wrap
        gap="small"
        style={{
          padding: token.paddingXS,
          borderBottom: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
        }}
      >
        <Segmented<BoardView>
          aria-label="Board view"
          value={preferences.view}
          onChange={changeView}
          options={[
            { value: 'tree', label: 'Tree', icon: <ApartmentOutlined aria-hidden /> },
            { value: 'board', label: 'Board', icon: <AppstoreOutlined aria-hidden /> },
          ]}
        />
        {!tree && (
          <Space>
            <Button onClick={() => setCommentsOpen(true)}>Comments</Button>
            {!branches.some((b) => b.branch_id === board.primary_teammate_id && !b.archived) && (
              <Button onClick={() => setTeammateOpen(true)}>Primary teammate</Button>
            )}
          </Space>
        )}
      </Flex>
      <Flex style={{ flex: 1, minHeight: 0 }}>
        {/* Keep the navigator's scroll position on view switches, without giving
          Board a companion panel. Hidden children cannot take keyboard focus. */}
        <nav
          aria-label="Board navigator"
          hidden={!tree || (compact && detailOpen)}
          style={{
            width: compact ? '100%' : 320,
            minWidth: 280,
            maxWidth: compact ? '100%' : '40%',
            flexShrink: 0,
            borderRight: `${token.lineWidth}px solid ${token.colorBorderSecondary}`,
          }}
        >
          <BoardTreeNavigator
            board={board}
            branches={branches}
            actions={{
              ...actions,
              onSessionClick: (id) => {
                setContent(null);
                actions.onSessionClick(id);
              },
            }}
            preferences={preferences}
            updatePreferences={updatePreferences}
            onBranchClick={(id) => {
              setContent(null);
              (onBranchClick ?? navigation.goToBranch)(id);
            }}
            onContentClick={openContent}
          />
        </nav>
        <div
          hidden={tree || (compact && detailOpen)}
          style={{ flex: 1, minWidth: 0, height: '100%', position: 'relative' }}
        >
          {(canvasVisited || !tree) && canvas}
        </div>
        <section
          aria-label="Board detail"
          hidden={
            compact ? !conversationOpen && !detailOpen : !tree && !conversationOpen && !detailOpen
          }
          style={{
            flex: tree ? 1 : undefined,
            width: compact ? '100%' : tree ? undefined : '45%',
            minWidth: 0,
            height: '100%',
            borderLeft: !tree
              ? `${token.lineWidth}px solid ${token.colorBorderSecondary}`
              : undefined,
          }}
        >
          <div hidden={detailOpen} style={{ height: '100%' }}>
            {conversationOpen ? (
              conversation
            ) : (
              <Empty
                style={{ marginTop: token.marginXL }}
                description="Choose a session, or start one on a teammate or branch."
              />
            )}
          </div>
          {selectedContent && (
            <BoardContentDetail
              key={`${selectedContent.kind}:${selectedContent.id}`}
              board={board}
              client={actions.client}
              user={user}
              selection={selectedContent}
              onClose={() => {
                setContent(null);
                if (activeArtifactId) navigation.goToBoard(board.board_id);
              }}
            />
          )}
          {!selectedContent && branch && (
            <div style={{ height: '100%', overflow: 'auto', padding: token.padding }}>
              <Flex justify="end" style={{ marginBottom: token.marginSM }}>
                <Button onClick={() => navigation.goToBoard(board.board_id)}>Close branch</Button>
              </Flex>
              <BranchCard
                {...actions}
                branch={branch}
                repo={repos.get(branch.repo_id)}
                sessions={branchSessions ?? []}
                userById={users}
                onOpenSettings={actions.onOpenSettings}
                panelMode
              />
            </div>
          )}
        </section>
      </Flex>
      <Drawer
        open={teammateOpen}
        title="Primary teammate"
        onClose={() => setTeammateOpen(false)}
        size={compact ? '100%' : 420}
      >
        <BoardTeammatePanel {...actions} activeTab="teammate" teammateOnly />
      </Drawer>
      <Drawer
        open={commentsOpen}
        title="Comments"
        onClose={() => setCommentsOpen(false)}
        size={compact ? '100%' : 420}
      >
        <BoardComments board={board} actions={actions} />
      </Drawer>
    </Flex>
  );
}
