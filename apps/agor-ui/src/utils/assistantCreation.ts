import type { AgorClient, AssistantConfig, Board, BoardID, Branch, Repo } from '@agor-live/client';
import { CREATE_NEW_BOARD } from '@/utils/assistantConstants';
import { slugify } from '@/utils/repoSlug';

export interface AssistantCreationInput {
  displayName: string;
  description?: string;
  emoji?: string;
  boardChoice?: string;
  repoId: string;
  branchName?: string;
  sourceBranch?: string;
}

export interface AssistantCreationDeps {
  client: AgorClient | null;
  repoById: Map<string, Repo>;
  onCreateBranch: (
    repoId: string,
    data: {
      name: string;
      ref: string;
      createBranch: boolean;
      sourceBranch: string;
      pullLatest: boolean;
      boardId?: string;
    }
  ) => Promise<Branch | null>;
  onUpdateBranch: (
    branchId: string,
    updates: { board_id?: BoardID; custom_context?: Record<string, unknown>; notes?: string | null }
  ) => void;
}

/**
 * Shared assistant creation logic used by both the CreateDialog (via App.tsx)
 * and the SettingsModal AssistantsTable.
 *
 * Flow: resolve repo → generate branch name → optionally create board →
 * create branch → tag branch with assistant metadata.
 */
export async function createAssistantBranch(
  input: AssistantCreationInput,
  deps: AssistantCreationDeps
): Promise<Branch | null> {
  const repo = deps.repoById.get(input.repoId);
  const branchName = input.branchName || `private-${slugify(input.displayName)}`;
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

  // Create the branch
  const branch = await deps.onCreateBranch(input.repoId, {
    name: branchName,
    ref: branchName,
    createBranch: true,
    sourceBranch,
    pullLatest: true,
    boardId,
  });

  if (branch) {
    // Assign to board (if not already passed via boardId above)
    if (boardId && !branch.board_id) {
      deps.onUpdateBranch(branch.branch_id, {
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
    deps.onUpdateBranch(branch.branch_id, {
      custom_context: { assistant: assistantConfig },
      ...(input.description?.trim() ? { notes: input.description.trim() } : {}),
    });
  }

  return branch;
}
