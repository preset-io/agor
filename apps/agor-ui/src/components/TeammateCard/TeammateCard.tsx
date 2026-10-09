import type { Board, Branch } from '@agor-live/client';
import { getTeammateConfig, TEAMMATE_FRAMEWORK_REPO_SLUG } from '@agor-live/client';
import { Avatar, Flex, Typography, theme } from 'antd';
import { memo } from 'react';
import { useAgorStore } from '../../store/agorStore';
import { teammateEmoji, teammateLabel } from '../../utils/teammateLabels';
import { getTemplateBySourceBranch } from '../../utils/teammateTemplates';
// Home's pressable row primitive: teammate cards are Home-styled on the rail and in the directory.
import { HomePressable } from '../HomePage/HomeRow';

/** Home board description, then the template it was cut from; otherwise none. */
export function teammatePurpose(branch: Branch, board?: Board): string | undefined {
  const described = board?.description?.trim();
  if (described) return described;
  if (getTeammateConfig(branch)?.frameworkRepo !== TEAMMATE_FRAMEWORK_REPO_SLUG) return undefined;
  return getTemplateBySourceBranch(branch.base_ref?.replace(/^(refs\/heads\/|origin\/)/, ''))
    ?.description;
}

export const teammateOwner = (branch: Branch) => branch.primary_owner_user_id ?? branch.created_by;

export interface TeammateCardProps {
  branch: Branch;
  /** Shows "View only · ask {owner} for access" once access is known to stop at view. */
  viewOnly?: boolean;
  onOpenBoard?: (boardId: string) => void;
}

export const TeammateCard = memo(function TeammateCard({
  branch,
  viewOnly,
  onOpenBoard,
}: TeammateCardProps) {
  const { token } = theme.useToken();
  const owner = useAgorStore((s) => s.userById.get(teammateOwner(branch)));
  const board = useAgorStore((s) =>
    branch.board_id ? s.boardById.get(branch.board_id) : undefined
  );
  const ownerName = owner?.name || owner?.email || 'its owner';
  const purpose = teammatePurpose(branch, board);
  const small = { fontSize: token.fontSizeSM };
  return (
    <HomePressable
      onOpen={board && onOpenBoard ? () => onOpenBoard(board.board_id) : undefined}
      ariaLabel={`${teammateLabel(branch)}, open ${board?.name}`}
      tooltip={`Open ${board?.name}`}
      vertical
      gap={token.marginXS}
      style={{ padding: token.paddingSM }}
    >
      <Flex align="center" gap={token.marginSM} style={{ minWidth: 0 }}>
        <Avatar
          shape="square"
          size={32}
          style={{ background: token.colorFillSecondary, flex: '0 0 auto' }}
        >
          <span style={{ fontSize: token.fontSizeLG }}>{teammateEmoji(branch) ?? '🤖'}</span>
        </Avatar>
        <Flex vertical style={{ minWidth: 0, flex: 1 }}>
          <Typography.Text strong ellipsis>
            {teammateLabel(branch)}
          </Typography.Text>
          <Typography.Text type="secondary" ellipsis style={small}>
            by {ownerName}
          </Typography.Text>
        </Flex>
      </Flex>
      <Typography.Paragraph
        type="secondary"
        ellipsis={{ rows: 2, tooltip: purpose }}
        style={{ ...small, margin: 0, color: purpose ? undefined : token.colorTextTertiary }}
      >
        {purpose ?? 'No description yet'}
      </Typography.Paragraph>
      {viewOnly && (
        <Typography.Text type="secondary" style={small}>
          View only · ask {ownerName} for access
        </Typography.Text>
      )}
    </HomePressable>
  );
});
