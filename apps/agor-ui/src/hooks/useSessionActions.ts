/**
 * React hook for session CRUD operations
 *
 * Provides functions to create, update, fork, spawn sessions
 */

import type { AgorClient } from '@agor/core/api';
import type { AgenticToolName, Session, SessionID } from '@agor/core/types';
import { getDefaultPermissionMode, SessionStatus } from '@agor/core/types';
import { useState } from 'react';
import type { NewSessionConfig } from '../components/NewSessionModal';
import { getDaemonUrl } from '../config/daemon';
import { ACCESS_TOKEN_KEY } from './useAuth';

interface UseSessionActionsResult {
  createSession: (config: NewSessionConfig) => Promise<Session | null>;
  updateSession: (sessionId: SessionID, updates: Partial<Session>) => Promise<Session | null>;
  deleteSession: (sessionId: SessionID) => Promise<boolean>;
  forkSession: (sessionId: SessionID, prompt: string) => Promise<Session | null>;
  spawnSession: (sessionId: SessionID, prompt: string) => Promise<Session | null>;
  creating: boolean;
  error: string | null;
}

/**
 * Session action operations
 *
 * @param client - Agor client instance
 * @returns Session action functions and state
 */
export function useSessionActions(
  client: AgorClient | null,
  accessToken?: string | null
): UseSessionActionsResult {
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const resolveAccessToken = (): string | null => {
    if (accessToken) {
      return accessToken;
    }

    if (typeof window !== 'undefined') {
      try {
        return window.localStorage.getItem(ACCESS_TOKEN_KEY);
      } catch (err) {
        console.error('Failed to read access token from storage:', err);
      }
    }

    return null;
  };

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
        permission_config: {
          mode: config.permissionMode || getDefaultPermissionMode(agenticTool),
        },
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

      // Call custom fork endpoint to create the forked session
      const token = resolveAccessToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${getDaemonUrl()}/sessions/${sessionId}/fork`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok) {
        throw new Error(`Fork failed: ${response.statusText}`);
      }

      const forkedSession = await response.json();

      // Send the prompt to the forked session to actually execute it
      await client.service(`sessions/${forkedSession.session_id}/prompt`).create({
        prompt,
      });

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

  const spawnSession = async (sessionId: SessionID, prompt: string): Promise<Session | null> => {
    if (!client) {
      setError('Client not connected');
      return null;
    }

    try {
      setCreating(true);
      setError(null);

      // Call custom spawn endpoint to create the spawned session
      const token = resolveAccessToken();
      const headers: Record<string, string> = { 'Content-Type': 'application/json' };
      if (token) {
        headers.Authorization = `Bearer ${token}`;
      }

      const response = await fetch(`${getDaemonUrl()}/sessions/${sessionId}/spawn`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ prompt }),
      });

      if (!response.ok) {
        throw new Error(`Spawn failed: ${response.statusText}`);
      }

      const spawnedSession = await response.json();

      // Send the prompt to the spawned session to actually execute it
      await client.service(`sessions/${spawnedSession.session_id}/prompt`).create({
        prompt,
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
