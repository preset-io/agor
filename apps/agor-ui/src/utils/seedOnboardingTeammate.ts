import type { AgenticToolName, AgorClient, Branch, Repo, Session } from '@agor-live/client';
import type { OnboardingIntegrationRecommendation } from './onboardingGoals';
import { startTeammateBootstrapSession } from './startTeammateBootstrapSession';
import {
  buildTeammateBootstrapPrompt,
  buildTeammateFirstSessionTitle,
} from './teammateBootstrapPrompt';
import { createTeammateBranch, type TeammateCreationDeps } from './teammateCreation';

export interface SeedOnboardingTeammateInput {
  /** Framework repo the teammate branches from — undefined while it's still cloning. */
  frameworkRepo: Repo | undefined;
  /** Board the wizard already created; the teammate is seeded onto it (no second board). */
  boardId: string;
  teammateName?: string;
  teammateEmoji?: string;
  /**
Framework source branch from the chosen gallery template. Undefined falls
   * back to the framework repo's default branch (createTeammateBranch). A
   * missing template branch on the remote surfaces as a non-fatal warning
   * rather than blocking completion.
   */
  sourceBranch?: string;
  /**
   * Agent chosen in the LLM step. `null`/`undefined` means the user skipped that
   * step and has no credentials, so no bootstrap session is started.
   */
  agent?: AgenticToolName | null;
  /** Goal-tailored tools/connections with their real Agor setup surface. */
  suggestedIntegrations?: OnboardingIntegrationRecommendation[];
  /** Onboarding goal ids (order-preserving, primary first); [] when skipped. */
  goals?: string[];
  user?: { name?: string | null; email?: string | null } | null;
  client: AgorClient | null;
  repoById: TeammateCreationDeps['repoById'];
  /** Current tenant-scoped maps used to resume a partially completed setup. */
  branchById: Map<string, Branch>;
  sessionById: Map<string, Session>;
  /** Exact prior result retained by the app while a completion retry is open. */
  existingBranchId?: string;
  existingSessionId?: string;
  onCreateBranch: TeammateCreationDeps['onCreateBranch'];
  onUpdateBranch: TeammateCreationDeps['onUpdateBranch'];
  onCreateSession: (config: unknown, boardId: string) => Promise<string | null>;
  /** Non-fatal warning surface — teammate creation must never block completion. */
  onWarn: (message: string) => void;
}

/**
 * Seeds the user's first AI teammate at the end of onboarding: a branch on the
 * framework repo plus a goal-primed onboarding session, reusing the board the
 * wizard already created.
 *
 * Best-effort by contract: if the framework repo isn't ready yet, or branch /
 * session creation throws, it surfaces a non-fatal warning and resolves without
 * a session so the caller can still finish onboarding on the board. Durable
 * branch/session ids are returned so completion retries can resume exactly.
 *
 * Skipping the LLM step is a supported outcome, not a failure: the teammate's
 * workspace is still created, but no session is started, so the caller lands the
 * user on their board rather than in a conversation that cannot run.
 */
function isOnboardingTeammateForBoard(branch: Branch, boardId: string): boolean {
  const teammate = branch.custom_context?.teammate as
    | { kind?: unknown; createdViaOnboarding?: unknown }
    | undefined;
  return (
    branch.board_id === boardId &&
    teammate?.kind === 'teammate' &&
    teammate.createdViaOnboarding === true
  );
}

async function findExistingOnboardingBranch(
  input: SeedOnboardingTeammateInput
): Promise<Branch | undefined> {
  if (input.existingBranchId) {
    const fromMap = input.branchById.get(input.existingBranchId);
    if (fromMap && isOnboardingTeammateForBoard(fromMap, input.boardId)) return fromMap;
    if (input.client) {
      try {
        const retained = (await input.client
          .service('branches')
          .get(input.existingBranchId)) as Branch;
        if (isOnboardingTeammateForBoard(retained, input.boardId)) return retained;
      } catch {
        // The retained id may have been deleted between retries. Fall through
        // to the board-scoped discovery and, if needed, create a replacement.
      }
    }
  }

  const fromMap = [...input.branchById.values()].find((branch) =>
    isOnboardingTeammateForBoard(branch, input.boardId)
  );
  if (fromMap || !input.client) return fromMap;

  // The root/home first paint intentionally loads branches in the background.
  // On a reload after a failed final preference patch, the durable onboarding
  // branch may therefore exist before it reaches the client map. Ask the
  // tenant-scoped service before creating; if discovery itself fails, let the
  // caller retry rather than guessing "absent" and duplicating a workspace.
  const result = await input.client.service('branches').find({
    query: { board_id: input.boardId, archived: false, $limit: 100 },
  });
  const branches = Array.isArray(result) ? result : result.data;
  return branches.find((branch) => isOnboardingTeammateForBoard(branch, input.boardId));
}

async function findExistingSession(
  input: SeedOnboardingTeammateInput,
  branchId: string
): Promise<Session | undefined> {
  if (input.existingSessionId) {
    const retained = input.sessionById.get(input.existingSessionId);
    if (retained?.branch_id === branchId) return retained;
    if (input.client) {
      try {
        const fetched = (await input.client
          .service('sessions')
          .get(input.existingSessionId)) as Session;
        if (fetched.branch_id === branchId) return fetched;
      } catch {
        // A retained session can be deleted while the completion screen is
        // open. Fall through to branch-scoped discovery before replacing it.
      }
    }
  }
  const fromMap = [...input.sessionById.values()].find((session) => session.branch_id === branchId);
  if (fromMap || !input.client) return fromMap;

  const result = await input.client.service('sessions').find({
    query: { branch_id: branchId, archived: false, $limit: 1 },
  });
  const sessions = Array.isArray(result) ? result : result.data;
  return sessions.find((session) => session.branch_id === branchId);
}

export async function seedOnboardingTeammate(
  input: SeedOnboardingTeammateInput
): Promise<{ branchId?: string; sessionId?: string }> {
  const teammateName = input.teammateName?.trim();
  // Nothing to seed — the user skipped naming a teammate.
  if (!teammateName || !input.boardId) return {};

  let branch: Branch | undefined;
  try {
    branch = await findExistingOnboardingBranch(input);
    if (branch) {
      // A refresh or failed final preference patch can leave the durable branch
      // behind while onboarding is still incomplete. Reassert the primary link
      // and continue from it instead of creating a duplicate git workspace.
      await input.client
        ?.service('boards')
        .setPrimaryTeammate({ boardId: input.boardId, branchId: branch.branch_id });
    } else {
      if (!input.frameworkRepo) {
        input.onWarn(
          "Your board is ready, but your AI teammate's workspace is still finishing setup. You can add a teammate from the board in a moment."
        );
        return {};
      }
      branch =
        (await createTeammateBranch(
          {
            displayName: teammateName,
            emoji: input.teammateEmoji,
            repoId: input.frameworkRepo.repo_id,
            sourceBranch: input.sourceBranch,
            boardId: input.boardId,
            createdViaOnboarding: true,
          },
          {
            client: input.client,
            repoById: input.repoById,
            onCreateBranch: input.onCreateBranch,
            onUpdateBranch: input.onUpdateBranch,
          }
        )) ?? undefined;
    }

    if (!branch) {
      input.onWarn(
        "Your board is ready, but we couldn't set up your AI teammate's workspace. You can add a teammate from the board anytime."
      );
      return {};
    }

    const existingSession = await findExistingSession(input, branch.branch_id);
    if (existingSession) {
      return { branchId: branch.branch_id, sessionId: existingSession.session_id };
    }

    // No agent means the LLM step was skipped: there is no configured model to
    // run on. Silently defaulting to claude-code here would open a session whose
    // very first turn fails on missing credentials, so stop at the workspace and
    // tell the user what to do instead.
    if (!input.agent) {
      input.onWarn(
        `${teammateName}'s workspace is ready. Connect an AI model in Settings - AI & Agents to start your first session.`
      );
      return { branchId: branch.branch_id };
    }

    const sessionId = await startTeammateBootstrapSession({
      client: input.client,
      branchId: branch.branch_id,
      boardId: branch.board_id || input.boardId,
      sessionConfig: {
        branch_id: branch.branch_id,
        agent: input.agent,
        title: buildTeammateFirstSessionTitle({
          displayName: teammateName,
          emoji: input.teammateEmoji,
        }),
        initialPrompt: buildTeammateBootstrapPrompt({
          displayName: teammateName,
          emoji: input.teammateEmoji,
          userName: input.user?.name,
          userEmail: input.user?.email,
          goals: input.goals,
          suggestedIntegrations: input.suggestedIntegrations,
        }),
      },
      onCreateSession: input.onCreateSession,
    });

    return { branchId: branch.branch_id, sessionId };
  } catch (error) {
    input.onWarn(
      `Your board is ready, but we couldn't start your AI teammate: ${
        error instanceof Error ? error.message : String(error)
      }. You can create one from the board anytime.`
    );
    return branch ? { branchId: branch.branch_id } : {};
  }
}
