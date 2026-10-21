import type { AgorClient, Board, User } from '@agor-live/client';
import { Typography, theme } from 'antd';
import { useParams } from 'react-router-dom';
import { resolveBoardFromUrlPure } from '@/utils/urlResolution';
import { useAgorStore } from '../../store/agorStore';
import { BoardFiles } from '../BoardFiles';
import { CompactNotice } from '../CompactNotice';
import { mobilePageStyle } from './constants';
import { BOARD_UNAVAILABLE } from './MobileBoardPage';
import { MobileBoardPreview } from './MobileBoardPreview';
import { MobileHeader } from './MobileHeader';
import { useMobileBack } from './useMobileBack';

/**
 * Files on phones: the board's ⋯ menu opens it full screen, as a route so the
 * phone's Back works. Search and type only; items open in a bottom sheet.
 */
export const MobileBoardFilesPage: React.FC<{
  client: AgorClient | null;
  currentUser?: User | null;
  boardById: Map<string, Board>;
}> = ({ client, currentUser, boardById }) => {
  const { token } = theme.useToken();
  const { boardId = '' } = useParams<{ boardId: string }>();
  // Boards arrive with the first workspace read; until then a missing board may still come.
  const loading = useAgorStore((state) => state.loading);
  const resolvedBoardId = boardById.has(boardId)
    ? boardId
    : resolveBoardFromUrlPure(boardId, boardById);
  const back = useMobileBack(`/m/board/${resolvedBoardId ?? boardId}`);
  return (
    <div style={mobilePageStyle}>
      <MobileHeader title="Files" onBack={back} />
      {resolvedBoardId ? (
        <MobileBoardPreview client={client} user={currentUser}>
          <div style={{ flex: 1, minHeight: 0 }}>
            <BoardFiles client={client} boardId={resolvedBoardId} active mobile />
          </div>
        </MobileBoardPreview>
      ) : loading ? (
        <Typography.Text type="secondary" style={{ padding: token.padding }}>
          Loading board…
        </Typography.Text>
      ) : (
        <CompactNotice
          type="neutral"
          message={BOARD_UNAVAILABLE}
          style={{ margin: token.padding }}
        />
      )}
    </div>
  );
};
