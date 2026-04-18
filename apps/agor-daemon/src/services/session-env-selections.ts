/**
 * Session Env Selections Service
 *
 * v0.5 env-var-access: tracks which session-scope env vars from the session
 * creator's env set are exported into each session's executor process.
 *
 * Selections are scoped per (session_id, env_var_name) and cascade-deleted
 * with the session. The join target (the creator's env var entry) is the
 * JSON map on `users.data.env_vars` — this table only stores names, not
 * values.
 *
 * RBAC: editable only by the session's creator or a global admin/superadmin
 * (see `ensureSessionOwnerOrAdmin`). Worktree-tier `all` grantees are NOT
 * granted access — session env selections expose the creator's private
 * credentials.
 */

import { type Database, SessionEnvSelectionRepository } from '@agor/core/db';
import type { QueryParams, SessionEnvSelection, SessionID } from '@agor/core/types';

/**
 * Session-env-selection params
 */
export type SessionEnvSelectionParams = QueryParams<{
  sessionId?: SessionID;
  envVarName?: string;
}>;

/**
 * Session Env Selections service
 */
export class SessionEnvSelectionsService {
  private repo: SessionEnvSelectionRepository;

  constructor(db: Database) {
    this.repo = new SessionEnvSelectionRepository(db);
  }

  /**
   * List all selections for a session.
   */
  async list(
    sessionId: SessionID,
    _params?: SessionEnvSelectionParams
  ): Promise<SessionEnvSelection[]> {
    return this.repo.list(sessionId);
  }

  /**
   * Add a single selection for a session.
   */
  async add(
    sessionId: SessionID,
    envVarName: string,
    _params?: SessionEnvSelectionParams
  ): Promise<void> {
    return this.repo.add(sessionId, envVarName);
  }

  /**
   * Remove a single selection from a session.
   */
  async remove(
    sessionId: SessionID,
    envVarName: string,
    _params?: SessionEnvSelectionParams
  ): Promise<void> {
    return this.repo.remove(sessionId, envVarName);
  }

  /**
   * Replace the full set of selections for a session (bulk operation).
   */
  async setAll(
    sessionId: SessionID,
    envVarNames: string[],
    _params?: SessionEnvSelectionParams
  ): Promise<void> {
    return this.repo.setAll(sessionId, envVarNames);
  }
}

/**
 * Service factory
 */
export function createSessionEnvSelectionsService(db: Database): SessionEnvSelectionsService {
  return new SessionEnvSelectionsService(db);
}
