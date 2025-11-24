/**
 * React hook for session CRUD operations
 *
 * Provides functions to create, update, fork, spawn sessions
 */

import type { AgorClient } from '@agor/core/api';
import type {
  AgenticToolName,
  PermissionMode,
  Session,
  SessionID,
  SpawnConfig,
} from '@agor/core/types';
import { getDefaultPermissionMode, SessionStatus } from '@agor/core/types';
import { useState } from 'react';
import type { NewSessionConfig } from '../components/NewSessionModal';

interface UseSessionActionsResult {
  createSession: (config: NewSessionConfig) => Promise<Session | null>;
  updateSession: (sessionId: SessionID, updates: Partial<Session>) => Promise<Session | null>;
  deleteSession: (sessionId: SessionID) => Promise<boolean>;
  forkSession: (sessionId: SessionID, prompt: string) => Promise<Session | null>;
  spawnSession: (sessionId: SessionID, config: Partial<SpawnConfig>) => Promise<Session | null>;
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

  const createSession = async (config: NewSessionConfig): Promise<Session | null> => {
    if (!client) {
      setError('Client not connected');
      return null;
    }

    try {
      setCreating(true);
      setError(null);

      // Worktree ID is now passed directly (resolved in NewSessionModal or from worktree creation)
      if (!config.worktree_id) {
        throw new Error('Worktree ID is required');
      }

      console.log(`Creating session with worktree_id: ${config.worktree_id}`);

      // Create session with worktree_id
      const agenticTool = config.agent as AgenticToolName;
      const permissionMode: PermissionMode =
        config.permissionMode || getDefaultPermissionMode(agenticTool);

      const permissionConfig: NonNullable<Session['permission_config']> = {
        mode: permissionMode,
      };

      if (agenticTool === 'codex') {
        permissionConfig.codex = {
          sandboxMode: config.codexSandboxMode || 'workspace-write',
          approvalPolicy: config.codexApprovalPolicy || 'on-request',
          networkAccess: config.codexNetworkAccess ?? false,
        };
      }

      const newSession = await client.service('sessions').create({
        agentic_tool: agenticTool,
        status: SessionStatus.IDLE,
        title: config.title || undefined,
        description: config.initialPrompt || undefined,
        worktree_id: config.worktree_id,
        model_config: config.modelConfig
          ? {
              ...config.modelConfig,
              updated_at: new Date().toISOString(),
            }
          : undefined,
        permission_config: permissionConfig,
      } as Partial<Session>);

      return newSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to create session';
      setError(message);
      console.error('Failed to create session:', err);
      return null;
    } finally {
      setCreating(false);
    }
  };

  const forkSession = async (sessionId: SessionID, prompt: string): Promise<Session | null> => {
    if (!client) {
      setError('Client not connected');
      return null;
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
        await client.service(`sessions/${forkedSession.session_id}/prompt`).create({
          prompt,
        });
      }

      return forkedSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to fork session';
      setError(message);
      console.error('Failed to fork session:', err);
      return null;
    } finally {
      setCreating(false);
    }
  };

  const spawnSession = async (
    sessionId: SessionID,
    config: Partial<SpawnConfig>
  ): Promise<Session | null> => {
    if (!client) {
      setError('Client not connected');
      return null;
    }

    try {
      setCreating(true);
      setError(null);

      // Call custom spawn endpoint via FeathersJS client with full SpawnConfig
      const spawnedSession = (await client
        .service(`sessions/${sessionId}/spawn`)
        .create(config)) as Session;

      // Send the prompt to the spawned session to actually execute it
      await client.service(`sessions/${spawnedSession.session_id}/prompt`).create({
        prompt: config.prompt,
      });

      return spawnedSession;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to spawn session';
      setError(message);
      console.error('Failed to spawn session:', err);
      return null;
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

  return {
    createSession,
    updateSession,
    deleteSession,
    forkSession,
    spawnSession,
    creating,
    error,
  };
}
