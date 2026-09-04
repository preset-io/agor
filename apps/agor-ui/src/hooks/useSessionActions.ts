/**
 * React hook for session CRUD operations
 *
 * Provides functions to create, update, fork, spawn sessions
 */

import type {
  AgenticToolName,
  AgorClient,
  PermissionMode,
  Session,
  SessionID,
  SpawnConfig,
} from '@agor-live/client';
import {
  getDefaultPermissionMode,
  mapToCodexPermissionConfig,
  SessionStatus,
} from '@agor-live/client';
import { useState } from 'react';
import type { NewSessionConfig } from '../domain/sessionCreation';

/** Options accepted by `POST /sessions/:id/archive` and `/unarchive`. */
export interface SessionArchiveOptions {
  /** Include branch-local spawned/forked descendants. Default: true. */
  includeChildren?: boolean;
  /** Follow sessions this one created in other branches. Default: true. */
  includeRemoteChildren?: boolean;
  /** Plan and authorize only; nothing changes. Default: false. */
  dryRun?: boolean;
}

/** Wire shape returned by the dedicated archive/unarchive routes. */
export interface SessionArchiveOutcome {
  session: Session;
  dryRun: boolean;
  /** Rows the plan would change (dry-run) or attempted (execution). */
  wouldChangeCount: number;
  archivedCount: number;
  unarchivedCount: number;
  localCount: number;
  remoteCount: number;
  skippedCount: number;
  /** Planned rows whose session is still executing. */
  runningCount: number;
  units: Array<{
    rootSessionId: SessionID;
    kind: 'local' | 'remote';
    status: 'changed' | 'unchanged' | 'skipped';
    changedCount: number;
    /** Only for units the caller is authorized for. */
    branchId?: string;
    reason?: 'insufficient_permission' | 'not_found' | 'conflict';
  }>;
  limitExceeded?: 'remote_depth' | 'remote_branch_units' | 'remote_session_targets';
  remainingArchived: Array<{
    sessionId: SessionID;
    reason: 'independent_reason' | 'archived_ancestor' | 'archived_branch';
  }>;
}

interface UseSessionActionsResult {
  createSession: (config: NewSessionConfig) => Promise<Session>;
  updateSession: (sessionId: SessionID, updates: Partial<Session>) => Promise<Session | null>;
  deleteSession: (sessionId: SessionID) => Promise<boolean>;
  // Throw on failure so callers can offer a targeted retry (for example
  // "archive only this session" after a shared-session child was denied).
  archiveSession: (
    sessionId: SessionID,
    options?: SessionArchiveOptions
  ) => Promise<SessionArchiveOutcome>;
  unarchiveSession: (
    sessionId: SessionID,
    options?: SessionArchiveOptions
  ) => Promise<SessionArchiveOutcome>;
  // Throw on failure (do NOT return null) so callers can preserve the user's
  // typed prompt in the compose box. See SessionPanel.handleFork / handleBtwSend
  // and ForkSpawnModal.handleOk for the preserved-on-failure invariants.
  forkSession: (sessionId: SessionID, prompt: string) => Promise<Session>;
  btwForkSession: (sessionId: SessionID, prompt: string) => Promise<Session>;
  spawnSession: (sessionId: SessionID, config: Partial<SpawnConfig>) => Promise<Session>;
  creating: boolean;
  error: string | null;
}

/**
 * Session action operations
 *
 * @param client - Agor client instance
 * @returns Session action functions and state
 */
export function useSessionActions(client: AgorClient | null): UseSessionActionsResult {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const createSession = async (config: NewSessionConfig): Promise<Session> => {
    if (!client) {
      setError('Client not connected');
      throw new Error('Client not connected');
    }

    try {
      setCreating(true);
      setError(null);

      // Branch ID is now passed directly (resolved in NewSessionModal or from branch creation)
      if (!config.branch_id) {
        throw new Error('Branch ID is required');
      }

      // Create session with branch_id
      const agenticTool = config.agent as AgenticToolName;
      const permissionMode: PermissionMode =
        config.permissionMode || getDefaultPermissionMode(agenticTool);

      const permissionConfig: NonNullable<Session['permission_config']> = {
        mode: permissionMode,
      };

      if (agenticTool === 'codex') {
        // Fill any missing field from the mode-derived defaults so the UI
        // doesn't silently restore the old `on-request` / network-off
        // behavior when advanced fields aren't expanded.
        const codexDefaults = mapToCodexPermissionConfig(permissionMode);
        permissionConfig.codex = {
          sandboxMode: config.codexSandboxMode ?? codexDefaults.sandboxMode,
          approvalPolicy: config.codexApprovalPolicy ?? codexDefaults.approvalPolicy,
          networkAccess: config.codexNetworkAccess ?? codexDefaults.networkAccess,
        };
      }

      const newSession = await client.service('sessions').create({
        agentic_tool: agenticTool,
        agentic_tool_preset_id: config.agenticToolPresetId,
        status: SessionStatus.IDLE,
        title: config.title || undefined,
        description: config.initialPrompt || undefined,
        branch_id: config.branch_id,
        model_config: config.modelConfig
          ? {
              ...config.modelConfig,
              ...(config.effort && { effort: config.effort }),
              updated_at: new Date().toISOString(),
            }
          : config.effort
            ? { effort: config.effort, updated_at: new Date().toISOString() }
            : undefined,
        permission_config: permissionConfig,
      });

      return newSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      setError(message);
      console.error('Failed to create session:', err);
      throw err;
    } finally {
      setCreating(false);
    }
  };

  const forkSession = async (sessionId: SessionID, prompt: string): Promise<Session> => {
    if (!client) {
      setError('Client not connected');
      throw new Error('Client not connected');
    }

    try {
      setCreating(true);
      setError(null);

      // Call custom fork endpoint via FeathersJS client
      const forkedSession = (await client.service(`sessions/${sessionId}/fork`).create({
        prompt,
      })) as Session;

      // Send the prompt to the forked session to actually execute it
      // Skip if prompt is empty (allows forking without initial prompt)
      if (prompt.trim()) {
        await client.sessions.prompt(forkedSession.session_id, prompt);
      }

      return forkedSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fork session';
      setError(message);
      console.error('Failed to fork session:', err);
      // Re-throw so callers (and modals) can distinguish failure from success
      // and keep the user's typed prompt from being silently discarded.
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setCreating(false);
    }
  };

  const btwForkSession = async (sessionId: SessionID, prompt: string): Promise<Session> => {
    if (!client) {
      setError('Client not connected');
      throw new Error('Client not connected');
    }

    try {
      setCreating(true);
      setError(null);

      // Fork the session
      const forkedSession = (await client.service(`sessions/${sessionId}/fork`).create({
        prompt,
      })) as Session;

      // Patch with btw metadata: fork_origin and auto-archive callback config
      await client.service('sessions').patch(forkedSession.session_id, {
        fork_origin: 'btw',
      } as Partial<Session>);

      // Send the prompt to the forked session
      if (prompt.trim()) {
        await client.sessions.prompt(forkedSession.session_id, prompt);
      }

      return forkedSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create btw fork';
      setError(message);
      console.error('Failed to create btw fork:', err);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setCreating(false);
    }
  };

  const spawnSession = async (
    sessionId: SessionID,
    config: Partial<SpawnConfig>
  ): Promise<Session> => {
    if (!client) {
      setError('Client not connected');
      throw new Error('Client not connected');
    }

    try {
      setCreating(true);
      setError(null);

      // Call custom spawn endpoint via FeathersJS client with full SpawnConfig
      const spawnedSession = (await client
        .service(`sessions/${sessionId}/spawn`)
        .create(config)) as Session;

      // Send the prompt to the spawned session to actually execute it
      if (config.prompt?.trim()) {
        await client.sessions.prompt(spawnedSession.session_id, config.prompt);
      }

      return spawnedSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn session';
      setError(message);
      console.error('Failed to spawn session:', err);
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setCreating(false);
    }
  };

  const updateSession = async (
    sessionId: SessionID,
    updates: Partial<Session>
  ): Promise<Session | null> => {
    if (!client) {
      setError('Client not connected');
      return null;
    }

    try {
      setError(null);
      const updatedSession = await client.service('sessions').patch(sessionId, updates);
      return updatedSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to update session';
      setError(message);
      console.error('Failed to update session:', err);
      return null;
    }
  };

  const deleteSession = async (sessionId: SessionID): Promise<boolean> => {
    if (!client) {
      setError('Client not connected');
      return false;
    }

    try {
      setError(null);
      await client.service('sessions').remove(sessionId);
      return true;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete session';
      setError(message);
      console.error('Failed to delete session:', err);
      return false;
    }
  };

  // The UI always states both cascade choices explicitly rather than relying on
  // the transport default, so what the confirmation showed is what is sent.
  const archiveRequestBody = (
    options?: SessionArchiveOptions
  ): Required<SessionArchiveOptions> => ({
    includeChildren: options?.includeChildren ?? true,
    includeRemoteChildren: options?.includeRemoteChildren ?? true,
    dryRun: options?.dryRun ?? false,
  });

  const runArchiveRoute = async (
    route: 'archive' | 'unarchive',
    sessionId: SessionID,
    options?: SessionArchiveOptions
  ): Promise<SessionArchiveOutcome> => {
    if (!client) {
      setError('Client not connected');
      throw new Error('Client not connected');
    }
    try {
      setError(null);
      return (await client
        .service(`sessions/${sessionId}/${route}`)
        .create(archiveRequestBody(options))) as SessionArchiveOutcome;
    } catch (err) {
      const message = err instanceof Error ? err.message : `Failed to ${route} session`;
      setError(message);
      console.error(`Failed to ${route} session:`, err);
      throw err instanceof Error ? err : new Error(message);
    }
  };

  const archiveSession = (sessionId: SessionID, options?: SessionArchiveOptions) =>
    runArchiveRoute('archive', sessionId, options);

  const unarchiveSession = (sessionId: SessionID, options?: SessionArchiveOptions) =>
    runArchiveRoute('unarchive', sessionId, options);

  return {
    createSession,
    updateSession,
    deleteSession,
    archiveSession,
    unarchiveSession,
    forkSession,
    btwForkSession,
    spawnSession,
    creating,
    error,
  };
}
