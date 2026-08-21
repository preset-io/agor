import type { AgorClient } from '@agor-live/client';
import { waitForBranchFilesystemReady } from './waitForBranchFilesystemReady';

export interface StartTeammateBootstrapSessionInput<
  TSessionConfig,
  TInitialization extends { sessionId: string },
> {
  client: AgorClient | null;
  branchId: string;
  boardId: string;
  sessionConfig: TSessionConfig;
  onCreateSession: (config: TSessionConfig, boardId: string) => Promise<TInitialization | null>;
  onStatusChange?: (status: string) => void;
  /** Abort caller-owned stages after an authenticated-identity change. */
  shouldContinue?: () => boolean;
}

/**
 * Shared bootstrap-session runner for newly created AI teammates.
 *
 * Keeps the branch-filesystem readiness wait and first-session create behavior
 * consistent between onboarding and the Teammate create dialog while letting
 * each caller own its own navigation/fallback UI.
 */
export async function startTeammateBootstrapSession<
  TSessionConfig,
  TInitialization extends { sessionId: string },
>({
  client,
  branchId,
  boardId,
  sessionConfig,
  onCreateSession,
  onStatusChange,
  shouldContinue = () => true,
}: StartTeammateBootstrapSessionInput<TSessionConfig, TInitialization>): Promise<TInitialization> {
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  onStatusChange?.('Preparing AI teammate worktree…');
  await waitForBranchFilesystemReady(client, branchId);

  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  onStatusChange?.('Starting first session…');
  const initialization = await onCreateSession(sessionConfig, boardId);
  if (!shouldContinue()) throw new Error('Teammate setup was cancelled.');
  if (!initialization) {
    throw new Error('First AI teammate session could not be created.');
  }

  return initialization;
}
