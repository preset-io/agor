import type { Board, Branch, Repo } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';
import { Flex, Typography, theme } from 'antd';

export const teammateLabel = (branch: Branch) =>
  getTeammateConfig(branch)?.displayName ?? branch.name;

export const teammateEmoji = (branch: Branch) => getTeammateConfig(branch)?.emoji;

/** Where the teammate lives — its board, falling back to the repo slug. */
export function teammateContext(
  branch: Branch,
  boardById: Map<string, Board>,
  repoById: Map<string, Repo>
): string {
  const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
  if (board) return `${board.icon ?? '📋'} ${board.name}`;
  return repoById.get(branch.repo_id)?.slug ?? 'Unknown board';
}

export interface TeammateOption {
  value: string;
  label: string;
  emoji: string;
  /** Omitted when the board is just the teammate's name. */
  context?: string;
  searchText: string;
  branch: Branch;
}

const bare = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Names that differ only in case, spacing or punctuation ("Hodor!" / "Hodor"). */
export const sameName = (a: string, b: string) => bare(a) === bare(b);

export function teammateOption(
  branch: Branch,
  boardById: Map<string, Board>,
  repoById: Map<string, Repo>
): TeammateOption {
  const label = teammateLabel(branch);
  const board = branch.board_id ? boardById.get(branch.board_id) : undefined;
  const context =
    board && sameName(board.name, label) ? undefined : teammateContext(branch, boardById, repoById);
  return {
    value: branch.branch_id,
    label,
    emoji: teammateEmoji(branch) ?? '🤖',
    context,
    searchText: `${label} ${branch.name} ${context ?? ''}`,
    branch,
  };
}

/** One line: emoji, name, then the board in regular secondary text. */
export const TeammateOptionLabel: React.FC<{ option: TeammateOption }> = ({ option }) => {
  const { token } = theme.useToken();
  return (
    <Flex gap={token.marginXS} align="center" style={{ minWidth: 0 }}>
      <span aria-hidden>{option.emoji}</span>
      <Typography.Text ellipsis style={{ flex: '0 1 auto' }}>
        {option.label}
      </Typography.Text>
      {option.context && (
        <Typography.Text type="secondary" ellipsis style={{ fontWeight: 'normal' }}>
          {option.context}
        </Typography.Text>
      )}
    </Flex>
  );
};
