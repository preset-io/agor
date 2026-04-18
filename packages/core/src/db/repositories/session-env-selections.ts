/**
 * Session Env Selection Repository
 *
 * Manages the many-to-many relationship between sessions and user-owned
 * session-scope env vars (v0.5 env-var-access).
 *
 * See `context/explorations/env-var-access.md`.
 */

import type { SessionEnvSelection, SessionID } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, select } from '../database-wrapper';
import { type SessionEnvSelectionRow, sessionEnvSelections } from '../schema';
import { RepositoryError } from './base';

export class SessionEnvSelectionRepository {
  constructor(private db: Database) {}

  /** Shared SELECT for a session's rows — single source of truth for reads. */
  private async fetchRows(sessionId: SessionID): Promise<SessionEnvSelectionRow[]> {
    try {
      return await select(this.db)
        .from(sessionEnvSelections)
        .where(eq(sessionEnvSelections.session_id, sessionId))
        .all();
    } catch (error) {
      throw new RepositoryError(
        `Failed to list session env selections: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** List selected env var names for a session (not hydrated). */
  async listNames(sessionId: SessionID): Promise<string[]> {
    const rows = await this.fetchRows(sessionId);
    return rows.map((r) => r.env_var_name);
  }

  /** Return a Set for fast membership checks in the env resolver. */
  async asSet(sessionId: SessionID): Promise<Set<string>> {
    const names = await this.listNames(sessionId);
    return new Set(names);
  }

  /** Full rows with timestamps — for the REST API response. */
  async list(sessionId: SessionID): Promise<SessionEnvSelection[]> {
    const rows = await this.fetchRows(sessionId);
    return rows.map((r) => ({
      session_id: r.session_id,
      env_var_name: r.env_var_name,
      created_at: new Date(r.created_at),
    }));
  }

  /** Add a selection. No-op if it already exists. */
  async add(sessionId: SessionID, envVarName: string): Promise<void> {
    try {
      const existing = await select(this.db)
        .from(sessionEnvSelections)
        .where(
          and(
            eq(sessionEnvSelections.session_id, sessionId),
            eq(sessionEnvSelections.env_var_name, envVarName)
          )
        )
        .one();
      if (existing) return;

      await insert(this.db, sessionEnvSelections)
        .values({
          session_id: sessionId,
          env_var_name: envVarName,
          created_at: new Date(),
        })
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to add session env selection: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Remove a selection. No-op if it doesn't exist. */
  async remove(sessionId: SessionID, envVarName: string): Promise<void> {
    try {
      await deleteFrom(this.db, sessionEnvSelections)
        .where(
          and(
            eq(sessionEnvSelections.session_id, sessionId),
            eq(sessionEnvSelections.env_var_name, envVarName)
          )
        )
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to remove session env selection: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /** Bulk replace — deletes all existing rows, inserts the new set. */
  async setAll(sessionId: SessionID, envVarNames: string[]): Promise<void> {
    try {
      await deleteFrom(this.db, sessionEnvSelections)
        .where(eq(sessionEnvSelections.session_id, sessionId))
        .run();
      if (envVarNames.length === 0) return;
      const now = new Date();
      await insert(this.db, sessionEnvSelections)
        .values(
          envVarNames.map((name) => ({
            session_id: sessionId,
            env_var_name: name,
            created_at: now,
          }))
        )
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to set session env selections: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
