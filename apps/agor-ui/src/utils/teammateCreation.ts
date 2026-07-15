import type { AgorClient, Board, BoardID, Branch, Repo, TeammateConfig } from '@agor-live/client';
import { slugify } from '@/utils/repoSlug';
import { ensureTeammateWelcomeNote } from '@/utils/teammateWelcomeNote';

export interface TeammateCreationInput {
  displayName: string;
  description?: string;
  emoji?: string;
  repoId: string;
  branchName?: string;
  sourceBranch?: string;
  /**
   * Reuse an existing board for the teammate instead of creating a new one.
   * The onboarding wizard already creates a board in its workspace step, so it
   * passes that board here to avoid ending up with two boards for one teammate.
   * When omitted (e.g. the CreateDialog flow), a fresh board is created.
   */
  boardId?: string;
  /** Tags the teammate as onboarding-seeded so its card shows the right copy. */
  createdViaOnboarding?: boolean;
}

export interface TeammateCreationDeps {
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
      custom_context?: Record<string, unknown>;
      notes?: string | null;
    }
  ) => Promise<Branch | null>;
  onUpdateBranch: (
    branchId: string,
    updates: { board_id?: BoardID; custom_context?: Record<string, unknown>; notes?: string | null }
  ) => void | Promise<void>;
}

/**
 * Shared teammate creation logic used by CreateDialog (via App.tsx).
 *
 * Flow: resolve repo → create board → create branch → tag branch with
 * teammate metadata → designate the branch as the board primary.
 */
export async function createTeammateBranch(
  input: TeammateCreationInput,
  deps: TeammateCreationDeps
): Promise<Branch | null> {
  const repo = deps.repoById.get(input.repoId);
  const branchName = input.branchName || `private-${slugify(input.displayName)}`;
  const sourceBranch = input.sourceBranch || repo?.default_branch || 'main';

  if (!deps.client) {
    throw new Error('Not connected');
  }

  const displayName = input.displayName.trim() || 'My Teammate';
  // Reuse the caller's board (onboarding) or create a fresh one (CreateDialog).
  let boardId: string;
  if (input.boardId) {
    boardId = input.boardId;
  } else {
    const newBoard = (await deps.client.service('boards').create({
      name: `${displayName}'s Board`,
      icon: input.emoji || '\u{1F916}',
    })) as Board;
    boardId = newBoard.board_id;
  }

  await ensureTeammateWelcomeNote({
    client: deps.client,
    boardId,
    teammateName: displayName,
    teammateEmoji: input.emoji,
  });

  const teammateConfig: TeammateConfig = {
    kind: 'teammate',
    displayName: input.displayName.trim(),
    emoji: input.emoji || undefined,
    frameworkRepo: repo?.slug,
    createdViaOnboarding: input.createdViaOnboarding ?? false,
  };

  // Create the branch with teammate metadata on the initial row. That keeps
  // the board card consistent immediately and avoids a race where a later
  // executor readiness patch can arrive before the UI sees the metadata patch.
  const branch = await deps.onCreateBranch(input.repoId, {
    name: branchName,
    ref: branchName,
    createBranch: true,
    sourceBranch,
    pullLatest: true,
    boardId,
    custom_context: { teammate: teammateConfig },
    ...(input.description?.trim() ? { notes: input.description.trim() } : {}),
  });

  if (branch) {
    // Assign to board (if not already passed via boardId above)
    if (boardId && !branch.board_id) {
      await deps.onUpdateBranch(branch.branch_id, {
        board_id: boardId as BoardID,
      });
    }
    if (boardId) {
      await deps.client
        ?.service('boards')
        .setPrimaryTeammate({ boardId, branchId: branch.branch_id });
    }
  }

  return branch;
}
