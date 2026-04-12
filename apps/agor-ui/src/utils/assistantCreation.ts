import type {
  AgorClient,
  AssistantConfig,
  Board,
  BoardID,
  Repo,
  Worktree,
} from '@agor-live/client';
import { CREATE_NEW_BOARD } from '@/utils/assistantConstants';
import { slugify } from '@/utils/repoSlug';

export interface AssistantCreationInput {
  displayName: string;
  description?: string;
  emoji?: string;
  boardChoice?: string;
  repoId: string;
  worktreeName?: string;
  sourceBranch?: string;
}

export interface AssistantCreationDeps {
  client: AgorClient | null;
  repoById: Map<string, Repo>;
  onCreateWorktree: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
    }
  ) => Promise<Worktree | null>;
  onUpdateWorktree: (
    worktreeId: string,
    updates: { board_id?: BoardID; custom_context?: Record<string, unknown>; notes?: string | null }
  ) => void;
}

/**
 * Shared assistant creation logic used by both the CreateDialog (via App.tsx)
 * and the SettingsModal AssistantsTable.
 *
 * Flow: resolve repo → generate worktree name → optionally create board →
 * create worktree → tag worktree with assistant metadata.
 */
export async function createAssistantWorktree(
  input: AssistantCreationInput,
  deps: AssistantCreationDeps
): Promise<Worktree | null> {
  const repo = deps.repoById.get(input.repoId);
  const worktreeName = input.worktreeName || `private-${slugify(input.displayName)}`;
  const sourceBranch = input.sourceBranch || repo?.default_branch || 'main';

  // Create a new board if requested
  let boardId: string | undefined;
  if (input.boardChoice === CREATE_NEW_BOARD) {
    if (deps.client) {
      try {
        const newBoard = (await deps.client.service('boards').create({
          name: input.displayName.trim(),
          icon: input.emoji || '\u{1F916}',
        })) as Board;
        boardId = newBoard.board_id;
      } catch (err) {
        console.error('Failed to create board:', err);
      }
    }
  } else if (input.boardChoice) {
    boardId = input.boardChoice;
  }

  // Create the worktree
  const worktree = await deps.onCreateWorktree(input.repoId, {
    name: worktreeName,
    ref: worktreeName,
    createBranch: true,
    sourceBranch,
    pullLatest: true,
    boardId,
  });

  if (worktree) {
    // Assign to board (if not already passed via boardId above)
    if (boardId && !worktree.board_id) {
      deps.onUpdateWorktree(worktree.worktree_id, {
        board_id: boardId as BoardID,
      });
    }

    // Tag as assistant and set description as notes
    const assistantConfig: AssistantConfig = {
      kind: 'assistant',
      displayName: input.displayName.trim(),
      emoji: input.emoji || undefined,
      frameworkRepo: repo?.slug,
      createdViaOnboarding: false,
    };
    deps.onUpdateWorktree(worktree.worktree_id, {
      custom_context: { assistant: assistantConfig },
      ...(input.description?.trim() ? { notes: input.description.trim() } : {}),
    });
  }

  return worktree;
}
