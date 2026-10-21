import { type BoardFileItem, type Branch, type BranchID, isTeammate } from '@agor-live/client';
import { AimOutlined } from '@ant-design/icons';
import { Button, Card, Flex, Tooltip, Typography, theme } from 'antd';
import { createContext, memo, useContext, useMemo } from 'react';
import { useBoardViewContext } from '../../contexts/BoardViewContext';
import { boardFilePreviewTarget, isPreviewing } from '../../hooks/useBoardPreview';
import { useAgorStore } from '../../store/agorStore';
import { makeBranchSelector } from '../../store/selectors';
import { boardFileStatus, boardFileTypeLabel } from '../../utils/boardFiles';
import { teammateLabel } from '../../utils/teammateLabels';
import { BoardFileIcon } from '../BoardFiles/BoardFileRow';
import { branchPreviewStatus } from '../BoardPreview/BranchDetailsPreview';

/** A conversation's work cards, placed by turn, for the task blocks that show them. */
export interface SessionWorkValue {
  sessionId: string;
  byTask: ReadonlyMap<string, BoardFileItem[]>;
  /** The latest turn, where the app and pull request card sits. */
  latestTaskId?: string;
  branchId?: string;
}

export const SessionWorkContext = createContext<SessionWorkValue | null>(null);

/** The session branch's app and pull request, as a card item, when it has either. */
export function appWorkItem(branch: Branch | undefined): BoardFileItem | null {
  if (!branch || branch.archived || !(branch.app_url || branch.pull_request_url)) return null;
  return {
    kind: 'app',
    id: branch.branch_id as BranchID,
    name: isTeammate(branch) ? teammateLabel(branch) : branch.name,
    made_at: branch.updated_at,
    made_by: { user_id: branch.created_by },
    source: 'board',
    status: branchPreviewStatus(branch),
  };
}

/**
 * A compact card in the transcript for something a turn made: icon, name,
 * "{type} · {status}" and one action. Chat and phones open it in the preview;
 * Board shows artifacts and apps on the board. Archived items stay, greyed.
 */
export const WorkCard = memo(function WorkCard({
  item,
  sessionId,
}: {
  item: BoardFileItem;
  sessionId: string;
}) {
  const { token } = theme.useToken();
  const boardView = useBoardViewContext();
  const type = boardFileTypeLabel(item.kind);
  const archived = !!item.archived;
  const showing = isPreviewing(boardView?.previewTarget, item);
  const onBoard = boardView?.view === 'board';
  const showsOnBoard = onBoard && (item.kind === 'artifact' || item.kind === 'app');

  const open = () => {
    if (!boardView) return;
    if (showsOnBoard) {
      boardView.showOnBoard(item.id, item.kind === 'app' ? 'branch' : 'artifact');
      return;
    }
    boardView.openPreview(boardFilePreviewTarget(item));
    // Board has no preview pane: a document opens beside this conversation in Chat.
    if (onBoard) boardView.openConversation(sessionId);
  };

  const action = showsOnBoard ? (
    <Button size="small" icon={<AimOutlined />} disabled={archived} onClick={open}>
      Show on board
    </Button>
  ) : (
    <Button
      size="small"
      type={showing ? 'default' : 'primary'}
      ghost={!showing}
      disabled={archived || showing || !boardView}
      onClick={open}
    >
      {showing ? 'Showing' : 'Open'}
    </Button>
  );

  return (
    <Card
      size="small"
      style={{
        maxWidth: 480,
        margin: `${token.marginXS}px 0`,
        // A ring rather than a border colour, so the card keeps its size and border.
        boxShadow: showing ? `0 0 0 1px ${token.colorPrimary}` : undefined,
      }}
      styles={{ body: { padding: `${token.paddingXS}px ${token.paddingSM}px` } }}
    >
      <Flex align="center" gap={token.marginSM}>
        <span style={{ display: 'flex', opacity: archived ? 0.45 : 1 }}>
          <BoardFileIcon item={item} size={24} />
        </span>
        <Flex vertical style={{ flex: 1, minWidth: 0 }}>
          <Typography.Text
            strong
            ellipsis={{ tooltip: item.name }}
            style={archived ? { color: token.colorTextDisabled } : undefined}
          >
            {item.name}
          </Typography.Text>
          <Typography.Text
            type="secondary"
            ellipsis
            style={{
              fontSize: token.fontSizeSM,
              ...(archived ? { color: token.colorTextDisabled } : {}),
            }}
          >
            {[type, archived ? 'No longer available' : boardFileStatus(item)]
              .filter(Boolean)
              .join(' · ')}
          </Typography.Text>
        </Flex>
        {archived ? (
          <Tooltip title={`This ${type.toLowerCase()} was archived.`}>
            {/* A disabled button gets no pointer events; the span carries the tooltip. */}
            <span>{action}</span>
          </Tooltip>
        ) : (
          action
        )}
      </Flex>
    </Card>
  );
});

/** The cards after one turn; the latest turn also gets the branch's app and pull request. */
export const TaskWorkCards: React.FC<{ taskId: string }> = ({ taskId }) => {
  const work = useContext(SessionWorkContext);
  const branch = useAgorStore(useMemo(() => makeBranchSelector(work?.branchId), [work?.branchId]));
  if (!work) return null;
  const items = work.byTask.get(taskId) ?? [];
  const app = taskId === work.latestTaskId ? appWorkItem(branch) : null;
  if (items.length === 0 && !app) return null;
  return (
    <div data-work-cards>
      {items.map((item) => (
        <WorkCard key={`${item.kind}:${item.id}`} item={item} sessionId={work.sessionId} />
      ))}
      {app && <WorkCard item={app} sessionId={work.sessionId} />}
    </div>
  );
};
