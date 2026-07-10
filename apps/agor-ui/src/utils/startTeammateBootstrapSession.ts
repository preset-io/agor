import type { AgorClient } from '@agor-live/client';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

export interface StartTeammateBootstrapSessionInput<TSessionConfig> {
  client: AgorClient | null;
  branchId: string;
  boardId: string;
  sessionConfig: TSessionConfig;
  onCreateSession: (config: TSessionConfig, boardId: string) => Promise<string | null>;
  onStatusChange?: (status: string) => void;
}

/**
 * Shared bootstrap-session runner for newly created AI teammates.
 *
 * Keeps the branch-filesystem readiness wait and first-session create behavior
 * consistent between onboarding and the Teammate create dialog while letting
 * each caller own its own navigation/fallback UI.
 */
export async function startTeammateBootstrapSession<TSessionConfig>({
  client,
  branchId,
  boardId,
  sessionConfig,
  onCreateSession,
  onStatusChange,
}: StartTeammateBootstrapSessionInput<TSessionConfig>): Promise<string> {
  onStatusChange?.('Preparing AI teammate worktree…');
  await waitForBranchFilesystemReady(client, branchId);

  onStatusChange?.('Starting first session…');
  const sessionId = await onCreateSession(sessionConfig, boardId);
  if (!sessionId) {
    throw new Error('First AI teammate session could not be created.');
  }

  return sessionId;
}
