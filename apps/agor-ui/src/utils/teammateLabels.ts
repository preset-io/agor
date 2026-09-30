import type { Board, Branch, Repo } from '@agor-live/client';
import { getTeammateConfig } from '@agor-live/client';

/** Shown for a teammate without an emoji of its own. */
export const DEFAULT_TEAMMATE_EMOJI = '🤖';

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

// Keeps letters, marks, digits and symbols (emoji, "+"); drops punctuation, spacing and emoji variation selectors, or only spacing when nothing else is left.
const bare = (text: string) => {
  const lower = text
    .normalize('NFC')
    .toLowerCase()
    .replace(/[\uFE0E\uFE0F]/gu, '');
  return lower.replace(/[^\p{L}\p{M}\p{N}\p{S}]/gu, '') || lower.replace(/\s/gu, '');
};

/** Names that differ only in case, spacing or punctuation ("Hodor!" / "Hodor"); symbols still count ("C++" / "C#"). */
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
    emoji: teammateEmoji(branch) ?? DEFAULT_TEAMMATE_EMOJI,
    context,
    searchText: `${label} ${branch.name} ${context ?? ''}`,
    branch,
  };
}
