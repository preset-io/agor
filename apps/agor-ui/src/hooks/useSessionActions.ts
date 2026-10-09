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
import { captureSessionPatchCommit } from '../store/realtimeBatch';
import { CLIENT_NOT_CONNECTED_ERROR, formatActionError } from '../utils/connectionErrors';

export const ARCHIVE_REFRESH_WARNING = 'Session archived. Refresh to update the list.';

type ArchiveSessionResult = {
  session: Session;
  reconciliation: 'confirmed' | 'refresh-required';
};

interface UseSessionActionsResult {
  createSession: (config: NewSessionConfig) => Promise<Session>;
  updateSession: (sessionId: SessionID, updates: Partial<Session>) => Promise<Session>;
  deleteSession: (sessionId: SessionID) => Promise<void>;
  archiveSession: (sessionId: SessionID) => Promise<ArchiveSessionResult>;
  unarchiveSession: (sessionId: SessionID) => Promise<Session>;
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
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
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
          includePlugins: config.codexIncludePlugins ?? false,
        };
      }

      const newSession = await client.service('sessions').create({
        agentic_tool: agenticTool,
        agentic_tool_preset_id: config.agenticToolPresetId,
        status: SessionStatus.IDLE,
        title: config.title || undefined,
        description: config.initialPrompt || undefined,
        branch_id: config.branch_id,
        mcpServerIds: config.mcpServerIds,
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
      throw err;
    } finally {
      setCreating(false);
    }
  };

  const forkSession = async (sessionId: SessionID, prompt: string): Promise<Session> => {
    if (!client) {
      setError('Client not connected');
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
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
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
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
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
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
      throw err instanceof Error ? err : new Error(message);
    } finally {
      setCreating(false);
    }
  };

  const updateSession = async (
    sessionId: SessionID,
    updates: Partial<Session>
  ): Promise<Session> => {
    if (!client) {
      setError(CLIENT_NOT_CONNECTED_ERROR);
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
    }

    try {
      setError(null);
      const updatedSession = await client.service('sessions').patch(sessionId, updates);
      return updatedSession;
    } catch (err) {
      setError(formatActionError('update the session', err, { idempotent: true }));
      // Let the request-local notification boundary report the actual failure;
      // shared hook state cannot identify which overlapping request failed.
      throw err;
    }
  };

  const deleteSession = async (sessionId: SessionID): Promise<void> => {
    if (!client) {
      setError(CLIENT_NOT_CONNECTED_ERROR);
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
    }

    try {
      setError(null);
      await client.service('sessions').remove(sessionId);
    } catch (err) {
      setError(formatActionError('delete the session', err, { idempotent: true }));
      throw err;
    }
  };

  const archiveSession = async (sessionId: SessionID): Promise<ArchiveSessionResult> => {
    if (!client) {
      setError(CLIENT_NOT_CONNECTED_ERROR);
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
    }

    try {
      setError(null);
      const commit = captureSessionPatchCommit();
      const result = (await client.service(`sessions/${sessionId}/archive`).create({})) as {
        session: Session;
        affectedSessions?: Session[];
      };
      // Do not depend on every descendant's realtime event arriving before the
      // drawer updates. Only reconcile server-confirmed rows, never infer a
      // cascade from the visible genealogy (which can include remote sessions).
      // Their payloads may already be stale: the store refetches these IDs.
      // affectedSessions contains changed rows only: an already-archived root
      // is returned separately and will not produce another realtime patch.
      const confirmed = new Map(
        [result.session, ...(result.affectedSessions ?? [])].map((session) => [
          session.session_id,
          session,
        ])
      );
      try {
        await commit([...confirmed.values()], (id) => client.service('sessions').get(id));
      } catch {
        return { session: result.session, reconciliation: 'refresh-required' };
      }
      return { session: result.session, reconciliation: 'confirmed' };
    } catch (err) {
      setError(formatActionError('archive the session', err, { idempotent: true }));
      throw err;
    }
  };

  const unarchiveSession = async (sessionId: SessionID): Promise<Session> => {
    if (!client) {
      setError(CLIENT_NOT_CONNECTED_ERROR);
      throw new Error(CLIENT_NOT_CONNECTED_ERROR);
    }

    try {
      setError(null);
      const result = (await client.service(`sessions/${sessionId}/unarchive`).create({})) as {
        session: Session;
      };
      return result.session;
    } catch (err) {
      setError(formatActionError('unarchive the session', err, { idempotent: true }));
      throw err;
    }
  };

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
