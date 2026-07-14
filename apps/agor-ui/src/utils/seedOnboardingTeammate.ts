import type { AgenticToolName, AgorClient, Repo } from '@agor-live/client';
import { startTeammateBootstrapSession } from './startTeammateBootstrapSession';
import { buildTeammateBootstrapPrompt } from './teammateBootstrapPrompt';
import { createTeammateBranch, type TeammateCreationDeps } from './teammateCreation';

export interface SeedOnboardingTeammateInput {
  /** Framework repo the teammate branches from — undefined while it's still cloning. */
  frameworkRepo: Repo | undefined;
  /** Board the wizard already created; the teammate is seeded onto it (no second board). */
  boardId: string;
  teammateName?: string;
  teammateEmoji?: string;
  /** Agent chosen in the LLM step; defaults to claude-code. */
  agent?: AgenticToolName | null;
  /** Persona-tailored MCP integration names to suggest in the bootstrap prompt. */
  suggestedIntegrations?: string[];
  user?: { name?: string | null; email?: string | null; persona?: string | null } | null;
  client: AgorClient | null;
  repoById: TeammateCreationDeps['repoById'];
  onCreateBranch: TeammateCreationDeps['onCreateBranch'];
  onUpdateBranch: TeammateCreationDeps['onUpdateBranch'];
  onCreateSession: (config: unknown, boardId: string) => Promise<string | null>;
  /** Non-fatal warning surface — teammate creation must never block completion. */
  onWarn: (message: string) => void;
}

/**
 * Seeds the user's first AI teammate at the end of onboarding: a branch on the
 * framework repo plus a persona-primed bootstrap session, reusing the board the
 * wizard already created.
 *
 * Best-effort by contract: if the framework repo isn't ready yet, or branch /
 * session creation throws, it surfaces a non-fatal warning and resolves without
 * a session so the caller can still finish onboarding on the board. Returns the
 * bootstrap session id when one was created.
 */
export async function seedOnboardingTeammate(
  input: SeedOnboardingTeammateInput
): Promise<{ sessionId?: string }> {
  const teammateName = input.teammateName?.trim();
  // Nothing to seed — the user skipped naming a teammate.
  if (!teammateName || !input.boardId) return {};

  if (!input.frameworkRepo) {
    input.onWarn(
      "Your board is ready, but your AI teammate's workspace is still finishing setup. You can add a teammate from the board in a moment."
    );
    return {};
  }

  try {
    const branch = await createTeammateBranch(
      {
        displayName: teammateName,
        emoji: input.teammateEmoji,
        repoId: input.frameworkRepo.repo_id,
        boardId: input.boardId,
        createdViaOnboarding: true,
      },
      {
        client: input.client,
        repoById: input.repoById,
        onCreateBranch: input.onCreateBranch,
        onUpdateBranch: input.onUpdateBranch,
      }
    );

    if (!branch) {
      input.onWarn(
        "Your board is ready, but we couldn't set up your AI teammate's workspace. You can add a teammate from the board anytime."
      );
      return {};
    }

    const sessionId = await startTeammateBootstrapSession({
      client: input.client,
      branchId: branch.branch_id,
      boardId: branch.board_id || input.boardId,
      sessionConfig: {
        branch_id: branch.branch_id,
        agent: input.agent ?? 'claude-code',
        title: `${input.teammateEmoji ? `${input.teammateEmoji} ` : ''}${teammateName} bootstrap`,
        initialPrompt: buildTeammateBootstrapPrompt({
          displayName: teammateName,
          emoji: input.teammateEmoji,
          userName: input.user?.name,
          userEmail: input.user?.email,
          persona: input.user?.persona,
          suggestedIntegrations: input.suggestedIntegrations,
        }),
      },
      onCreateSession: input.onCreateSession,
    });

    return { sessionId };
  } catch (error) {
    input.onWarn(
      `Your board is ready, but we couldn't start your AI teammate: ${
        error instanceof Error ? error.message : String(error)
      }. You can create one from the board anytime.`
    );
    return {};
  }
}
