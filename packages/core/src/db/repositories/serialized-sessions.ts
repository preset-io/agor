/**
 * Serialized Sessions Repository
 *
 * Manages SDK session file snapshots for stateless_fs_mode.
 * Each row stores a gzipped session file keyed by session + turn_index.
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { generateId } from '../../lib/ids';
import type { Database } from '../client';
import { deleteFrom, insert, select, update } from '../database-wrapper';
import {
  type SerializedSessionInsert,
  type SerializedSessionRow,
  serializedSessions,
} from '../schema';
import { RepositoryError } from './base';

export type SerializedSessionStatus = 'processing' | 'done';

export interface SerializedSession {
  id: string;
  session_id: string;
  worktree_id: string;
  task_id: string | null;
  turn_index: number;
  created_at: number;
  md5: string;
  status: SerializedSessionStatus;
  payload: Buffer | null;
}

function rowToSerializedSession(row: SerializedSessionRow): SerializedSession {
  return {
    id: row.id,
    session_id: row.session_id,
    worktree_id: row.worktree_id,
    task_id: row.task_id,
    turn_index: row.turn_index,
    created_at: new Date(row.created_at).getTime(),
    md5: row.md5,
    status: row.status as SerializedSessionStatus,
    payload: row.payload ?? null,
  };
}

export class SerializedSessionRepository {
  constructor(private db: Database) {}

  /**
   * Find the latest row with status='done' for a session (highest turn_index)
   */
  async findLatestDone(sessionId: string): Promise<SerializedSession | null> {
    try {
      const row = await select(this.db)
        .from(serializedSessions)
        .where(
          and(eq(serializedSessions.session_id, sessionId), eq(serializedSessions.status, 'done'))
        )
        .orderBy(desc(serializedSessions.turn_index), desc(serializedSessions.created_at))
        .limit(1)
        .one();

      return row ? rowToSerializedSession(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find latest done serialized session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Find the latest row regardless of status (to detect 'processing' rows)
   */
  async findLatest(sessionId: string): Promise<SerializedSession | null> {
    try {
      const row = await select(this.db)
        .from(serializedSessions)
        .where(eq(serializedSessions.session_id, sessionId))
        .orderBy(desc(serializedSessions.turn_index), desc(serializedSessions.created_at))
        .limit(1)
        .one();

      return row ? rowToSerializedSession(row) : null;
    } catch (error) {
      throw new RepositoryError(
        `Failed to find latest serialized session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Insert a new 'processing' row (payload NULL, fast write)
   */
  async insertProcessing(params: {
    id?: string;
    sessionId: string;
    worktreeId: string;
    taskId?: string;
    turnIndex: number;
    md5: string;
  }): Promise<SerializedSession> {
    try {
      const id = params.id ?? generateId();
      const now = Date.now();

      const insertData: SerializedSessionInsert = {
        id,
        session_id: params.sessionId,
        worktree_id: params.worktreeId,
        task_id: params.taskId ?? null,
        turn_index: params.turnIndex,
        created_at: new Date(now),
        md5: params.md5,
        status: 'processing',
        payload: null,
      };

      await insert(this.db, serializedSessions).values(insertData).run();

      return {
        id,
        session_id: params.sessionId,
        worktree_id: params.worktreeId,
        task_id: params.taskId ?? null,
        turn_index: params.turnIndex,
        created_at: now,
        md5: params.md5,
        status: 'processing',
        payload: null,
      };
    } catch (error) {
      throw new RepositoryError(
        `Failed to insert processing serialized session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Mark a row as 'done' and attach the gzipped payload
   */
  async markDone(id: string, payload: Buffer): Promise<void> {
    try {
      await update(this.db, serializedSessions)
        .set({ status: 'done', payload })
        .where(eq(serializedSessions.id, id))
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to mark serialized session as done: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete a single row by ID.
   */
  async deleteById(id: string): Promise<void> {
    try {
      await deleteFrom(this.db, serializedSessions).where(eq(serializedSessions.id, id)).run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete serialized session: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }

  /**
   * Delete all rows for a session with turn_index less than the given value.
   * Used to clean up old snapshots after a new one lands.
   */
  async deletePreviousTurns(sessionId: string, beforeTurnIndex: number): Promise<void> {
    try {
      await deleteFrom(this.db, serializedSessions)
        .where(
          and(
            eq(serializedSessions.session_id, sessionId),
            lt(serializedSessions.turn_index, beforeTurnIndex)
          )
        )
        .run();
    } catch (error) {
      throw new RepositoryError(
        `Failed to delete previous serialized sessions: ${error instanceof Error ? error.message : String(error)}`,
        error
      );
    }
  }
}
