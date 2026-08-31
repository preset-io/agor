/**
 * Session Env Selection Repository
 *
 * Manages the many-to-many relationship between sessions and user-owned
 * session-scope env vars (v0.5 env-var-access).
 *
 * See `context/explorations/env-var-access.md`.
 */

import type { SessionEnvSelection, SessionID, UserID } from '@agor/core/types';
import { and, eq } from 'drizzle-orm';
import type { Database } from '../client';
import { deleteFrom, insert, lockRowForUpdate, select } from '../database-wrapper';
import { type SessionEnvSelectionRow, sessionEnvSelections, sessions } from '../schema';
import { getCurrentTenantId } from '../tenant-context';
import { runWithTenantDatabaseTransaction } from '../tenant-scope';
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

  /**
   * Return selections only when the Session belongs to the execution user.
   *
   * A selection row names a variable but does not name its owning user; that
   * ownership is implicit in `sessions.created_by`. Callers resolving user A's
   * environment must not be able to use user B's session as an oracle that
   * selects same-named secrets from A's profile.
   */
  async asSetForOwner(sessionId: SessionID, userId: UserID): Promise<Set<string>> {
    try {
      const rows = await select(this.db, { env_var_name: sessionEnvSelections.env_var_name })
        .from(sessionEnvSelections)
        .innerJoin(
          sessions,
          and(
            eq(sessions.session_id, sessionEnvSelections.session_id),
            eq(sessions.created_by, userId)
          )
        )
        .where(eq(sessionEnvSelections.session_id, sessionId))
        .all();
      return new Set(rows.map((row: { env_var_name: string }) => row.env_var_name));
    } catch (error) {
      throw new RepositoryError(
        `Failed to list owner-bound session env selections: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
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
      await insert(this.db, sessionEnvSelections)
        .values({
          session_id: sessionId,
          env_var_name: envVarName,
          created_at: new Date(),
        })
        .onConflictDoNothing()
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
      await runWithTenantDatabaseTransaction(this.db, getCurrentTenantId(), async (mutationDb) => {
        // Serialize replacement across PostgreSQL replicas on the durable
        // parent row. SQLite's IMMEDIATE transaction is the equivalent writer
        // fence. Without this, two delete+insert replacements can commit a
        // union rather than either caller's complete set.
        await lockRowForUpdate(mutationDb, this.db, sessions, eq(sessions.session_id, sessionId));
        await deleteFrom(mutationDb, sessionEnvSelections)
          .where(eq(sessionEnvSelections.session_id, sessionId))
          .run();
        if (envVarNames.length === 0) return;
        const now = new Date();
        await insert(mutationDb, sessionEnvSelections)
          .values(
            envVarNames.map((name) => ({
              session_id: sessionId,
              env_var_name: name,
              created_at: now,
            }))
          )
          .run();
      });
    } catch (error) {
      throw new RepositoryError(
        `Failed to set session env selections: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
