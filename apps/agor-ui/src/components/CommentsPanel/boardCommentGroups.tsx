import type { BoardComment, BoardObject, Branch } from '@agor-live/client';
import { AppstoreOutlined, BranchesOutlined } from '@ant-design/icons';
import { theme } from 'antd';
import { useCallback } from 'react';
import { ZONE_CONTENT_OPACITY } from '../SessionCanvas/canvas/BoardObjectNodes';
import type { CommentGroup } from './CommentsPanel';

const ZONE_SWATCH_SIZE = 12;

// Scope hierarchy, largest first: board → zones → branches.
const SORT_RANK = { board: 0, zone: 1, branch: 2 };

const ZoneSwatch: React.FC<{ color: string }> = ({ color }) => (
  <div
    style={{
      width: ZONE_SWATCH_SIZE,
      height: ZONE_SWATCH_SIZE,
      // Transparent fill matching the zone background, solid border in zone color.
      backgroundColor: `${color}${Math.round(ZONE_CONTENT_OPACITY * 255)
        .toString(16)
        .padStart(2, '0')}`,
      border: `1px solid ${color}`,
      borderRadius: 2,
    }}
  />
);

/**
 * Groups board comments by the object they are pinned or attached to.
 */
export function useBoardCommentGroupResolver(options: {
  boardObjects?: Record<string, BoardObject>;
  branchById?: Map<string, Branch>;
}): (comment: BoardComment) => CommentGroup {
  const { token } = theme.useToken();
  const { boardObjects, branchById } = options;

  return useCallback(
    (comment) => {
      const branchGroup = (branchId: string): CommentGroup => ({
        key: `branch-${branchId}`,
        label: branchById?.get(branchId)?.name ?? 'Unknown Branch',
        icon: <BranchesOutlined style={{ fontSize: 14, color: token.colorPrimary }} />,
        sortRank: SORT_RANK.branch,
      });

      const relative = comment.position?.relative;

      if (relative?.parent_type === 'zone') {
        // Zone keys carry a 'zone-' prefix in the board object map.
        const zone = boardObjects?.[`zone-${relative.parent_id}`];
        const color = zone && 'color' in zone ? zone.color : undefined;
        return {
          key: `zone-${relative.parent_id}`,
          label: zone && 'label' in zone ? zone.label : 'Zone',
          icon: color ? <ZoneSwatch color={color} /> : undefined,
          sortRank: SORT_RANK.zone,
        };
      }

      if (relative?.parent_type === 'branch') return branchGroup(relative.parent_id);
      if (comment.branch_id) return branchGroup(comment.branch_id);

      return {
        key: 'board',
        label: 'Board',
        icon: <AppstoreOutlined style={{ fontSize: 14, color: token.colorPrimary }} />,
        sortRank: SORT_RANK.board,
      };
    },
    [boardObjects, branchById, token.colorPrimary]
  );
}
