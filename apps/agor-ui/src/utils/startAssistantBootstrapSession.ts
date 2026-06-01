import type { AgorClient } from '@agor-live/client';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

export interface StartAssistantBootstrapSessionInput<TSessionConfig> {
  client: AgorClient | null;
  branchId: string;
  boardId: string;
  sessionConfig: TSessionConfig;
  onCreateSession: (config: TSessionConfig, boardId: string) => Promise<string | null>;
  onStatusChange?: (status: string) => void;
}

/**
 * Shared bootstrap-session runner for newly created assistants.
 *
 * Keeps the branch-filesystem readiness wait and first-session create behavior
 * consistent between onboarding and the Assistant create dialog while letting
 * each caller own its own navigation/fallback UI.
 */
export async function startAssistantBootstrapSession<TSessionConfig>({
  client,
  branchId,
  boardId,
  sessionConfig,
  onCreateSession,
  onStatusChange,
}: StartAssistantBootstrapSessionInput<TSessionConfig>): Promise<string> {
  onStatusChange?.('Preparing assistant worktree…');
  await waitForBranchFilesystemReady(client, branchId);

  onStatusChange?.('Starting first session…');
  const sessionId = await onCreateSession(sessionConfig, boardId);
  if (!sessionId) {
    throw new Error('First assistant session could not be created.');
  }

  return sessionId;
}
